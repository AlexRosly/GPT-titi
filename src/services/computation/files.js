const store=require('../files/store');const {limits,fail}=require('./policy');
const path=require('node:path');
async function candidates(turn,model){
 const history=await require('../files/textContext').forTurn(turn);const found=new Map();
 for(const m of history)for(const a of m.attachments||[]){
  if(a.storage!=='private'||!store.idOK(String(a.fileId)))continue;
  let f;try{f=await store.owned(turn.user,String(a.fileId));}catch(e){if(e.fileError==='FILE_NOT_FOUND')continue;throw e;}
  const ext=path.extname(f.originalName).slice(1).toLowerCase();
  if(require('../files/textInput').supported(f)&&!require('../files/textInput').enabled(model))continue;
  if(['docx','xlsx'].includes(ext)&&!require('../files/officeInput').enabled(model))continue;
  if(ext==='pdf'&&!require('../files/pdfInput').enabled(model))continue;
  if(ext==='zip'){
   const zip=require('../files/zipInput');if(!zip.enabled(model)||!zip.cached(f))continue;
   try{zip.allowed(f.zipCache.kinds,model);}catch{continue;}
  }
  if(![...require('../files/validation').textExtensions,'docx','xlsx','pdf','zip','png','jpg','jpeg','webp'].includes(ext))continue;
  found.set(String(f._id),{fileId:String(f._id),name:f.originalName,size:f.size});
 }
 return [...found.values()].slice(-30);
}
async function inputs(turn,action,available){
 const files=[];let bytes=0;
 for(const id of action.fileIds){
  if(!available.some(f=>f.fileId===id))throw fail('COMPUTE_FILE_FORBIDDEN');
  const {file,buffer}=await store.read(turn.user,id);
  require('../files/validation').safeName(file.originalName);
  bytes+=buffer.length;if(bytes>limits().inputBytes)throw fail('COMPUTE_FILE_LIMIT');
  files.push({path:'input/'+id+'/'+file.originalName,data:buffer.toString('base64')});
 }
 for(const ref of turn.computeState.files||[]){
  const {file,buffer}=await store.read(turn.user,ref.fileId);bytes+=buffer.length;
  if(bytes>limits().inputBytes)throw fail('COMPUTE_FILE_LIMIT');
  files.push({path:'previous/'+file.originalName,data:buffer.toString('base64')});
 }
 return files;
}
async function outputs(response,action,model){
 if(!response.ok){if(response.exports.length)throw fail('COMPUTE_INVALID_RESULT');return [];}
 if(response.exports.length!==action.exports.length)throw fail('COMPUTE_INVALID_RESULT');
 if(response.exports.length&&!require('../files/artifacts').outputEnabled(model))throw fail('COMPUTE_OUTPUT_DISABLED');
 const out=[];let total=0;
 for(let i=0;i<response.exports.length;i++){
  const e=response.exports[i];if(e.filename!==action.exports[i].filename||typeof e.data!=='string'||e.data.length>Math.ceil(limits().outputBytes/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(e.data))throw fail('COMPUTE_INVALID_RESULT');
  const b=Buffer.from(e.data,'base64');if(b.toString('base64')!==e.data)throw fail('COMPUTE_INVALID_RESULT');total+=b.length;if(total>limits().outputBytes)throw fail('COMPUTE_OUTPUT_LIMIT');
  let result;
  if(/\.png$/i.test(e.filename))result=await require('./png')(e.filename,b);
  else {
   if(/\.zip$/i.test(e.filename)&&!require('../files/zipOutput').enabled(model))throw fail('ZIP_OUTPUT_DISABLED');
   let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{throw fail('COMPUTE_INVALID_RESULT');}
   result=await require('../files/artifacts').renderOutput({filename:e.filename},content);
  }
  out.push(result);
 }
 if(out.reduce((n,f)=>n+f.buffer.length,0)>limits().outputBytes)throw fail('COMPUTE_OUTPUT_LIMIT');
 return out;
}
module.exports={candidates,inputs,outputs};
