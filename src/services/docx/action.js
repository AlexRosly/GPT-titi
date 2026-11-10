// Adapter to the existing V2 computation transaction/checkpoint path.
const policy=require('./policy');
const store=require('../files/store');
const {fail}=require('../files/validation');
async function run({turn,model,call,available,signal}){
 if(!policy.enabled(model))throw fail('DOCX_EDIT_DISABLED');
 const args=policy.parse(call.function.name,call.function.arguments);
 const prior=turn.computeState?.files||[];
 if(!available.some(f=>f.fileId===args.fileId)&&!prior.some(f=>f.fileId===args.fileId))throw fail('COMPUTE_FILE_FORBIDDEN');
 const metadata=await store.owned(turn.user,args.fileId);
 if(!/\.docx$/i.test(metadata.originalName)||metadata.size>5*1024**2)throw fail('DOCX_EDIT_FILE_LIMIT');
 signal?.throwIfAborted();
 const {buffer}=await store.read(turn.user,args.fileId);
 if(call.function.name===policy.NAME_EDIT){
  const inspection=turn.computeState?.docxInspections?.[args.fileId];
  if(inspection!==args.sourceChecksum)throw fail('DOCX_INSPECTION_REQUIRED');
  if(args.filename.normalize('NFC').toLowerCase()===metadata.originalName.normalize('NFC').toLowerCase())throw fail('DOCX_NEW_FILENAME_REQUIRED');
 }
 const limits=require('../computation/policy').limits();
 const timeoutMs=Math.min(10000,limits.runMs,limits.totalMs-(turn.computeState?.executionMs||0));
 const output=await require('./process').run(buffer,call.function.name,args,signal,timeoutMs);
 signal?.throwIfAborted();
 if(output.inspection)return {result:{ok:true,text:JSON.stringify(output.inspection),truncated:false},prepared:[],
  statePatch:{docxInspections:{...turn.computeState.docxInspections,[args.fileId]:output.inspection.checksum}}};
 const result=Buffer.from(output.buffer);
 return {result:{ok:true,text:JSON.stringify({verification:{...output.report,operations:undefined,operationCount:output.report.operations.length},filename:args.filename}),truncated:false},
  prepared:[{name:args.filename,mimetype:require('../files/office').mimes.docx,buffer:result,documentEdit:{sourceFileId:args.fileId,...output.report}}],
  statePatch:{docxEdits:[...(turn.computeState.docxEdits||[]),{sourceFileId:args.fileId,...output.report}]}};
}
module.exports={run};
