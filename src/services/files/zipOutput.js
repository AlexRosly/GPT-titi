const path=require('node:path');const {fail}=require('./validation');const config=require('./config');
const {LIMITS,safePath}=require('./zipCodec');
const enabled=model=>process.env.ZIP_OUTPUT_ENABLED!=='false'&&model?.zipOutputEnabled!==false;
const instructions='For a ZIP file, content must be a JSON string with exactly {"files":[{"path":"folder/name.ext","content":"complete UTF-8 content"}]}. Include 1 to 10 files, at most 512 KiB for this entire JSON. Paths are relative and safe; no .., absolute paths, backslashes, symlinks or nested archives. Each file may use a supported text/code extension, SVG, PDF, DOCX or XLSX. For PDF/DOCX/XLSX, the entry content is the same document manifest JSON string described in the Office instructions. The server generates real binaries and packs them; never return base64, URLs or invented download links. No programs are executed.';
function manifest(content){
 if(typeof content!=='string'||Buffer.byteLength(content)>config.artifactBytes)throw fail('INVALID_ZIP_OUTPUT');
 let value;try{value=JSON.parse(content);}catch{throw fail('INVALID_ZIP_OUTPUT');}
 if(!value||Object.keys(value).length!==1||!Array.isArray(value.files)||!value.files.length||value.files.length>LIMITS.outputEntries)throw fail('INVALID_ZIP_OUTPUT');
 const seen=new Set();
 for(const f of value.files){
  if(!f||Object.keys(f).some(k=>!['path','content'].includes(k))||typeof f.content!=='string')throw fail('INVALID_ZIP_OUTPUT');
  safePath(f.path);const key=f.path.normalize('NFC').toLowerCase();
  if(seen.has(key)||[...seen].some(n=>n.startsWith(key+'/')||key.startsWith(n+'/')))throw fail('ZIP_UNSAFE_PATH');seen.add(key);
  if(/\.zip$/i.test(f.path))throw fail('ZIP_UNSUPPORTED_ENTRY');
  require('./artifacts').outputSpec({filename:path.posix.basename(f.path)});
 }
 return value.files;
}
async function render(spec,content){
 const files=manifest(content),entries=[],preview=[];let total=0;const deadline=Date.now()+90000;
 for(const f of files){
  if(Date.now()>deadline)throw fail('ZIP_PROCESSING_TIMEOUT');
  const result=await require('./artifacts').renderOutput({filename:path.posix.basename(f.path)},f.content);
  total+=result.buffer.length;if(total>LIMITS.expandedBytes)throw fail('ZIP_LIMIT');
  entries.push({path:f.path,buffer:result.buffer});preview.push({path:f.path,size:result.buffer.length,status:'created'});
 }
 const result=await require('./zipProcess')({action:'write',entries});const buffer=Buffer.from(result.buffer);
 if(buffer.length>config.maxBytes())throw fail('FILE_TOO_LARGE',413);
 return {name:spec.filename,mimetype:'application/zip',buffer,generatedPreview:{kind:'archive',entries:preview,truncated:false}};
}
module.exports={enabled,instructions,manifest,render};
