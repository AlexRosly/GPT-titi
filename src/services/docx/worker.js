const {parentPort,workerData}=require('node:worker_threads');
(async()=>{
 try{
  const engine=require('./engine'),buffer=Buffer.from(workerData.buffer);
  // Full production package validation runs inside the bounded worker too.
  const office=require('../files/officeInput');
  await office.extract(buffer,'docx');
  const doc=engine.load(buffer);
  if(workerData.action==='inspect_docx')parentPort.postMessage({inspection:engine.inspect(doc,workerData.args.target,workerData.args.offset)});
  else{
   if(doc.checksum!==workerData.args.sourceChecksum)throw require('../files/validation').fail('DOCX_SOURCE_CHANGED');
   const result=await engine.edit(doc,workerData.args.operations);
   await office.extract(result.buffer,'docx');
   parentPort.postMessage(result);
  }
 }catch(e){parentPort.postMessage({error:e.fileError||'DOCX_EDIT_FAILED'});}
})();
