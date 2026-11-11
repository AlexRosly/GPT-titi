const {Worker}=require('node:worker_threads'),path=require('node:path');
const {fail}=require('../files/validation');
let inspections=0;
async function run(buffer,action,args,{signal,selection,cursor=0,records,onChunk,timeoutMs=300000}={}){
 signal?.throwIfAborted();const preview=action==='inspect';
 if(preview&&inspections>=2)throw fail('XLSX_PROCESSING_BUSY');
 if(preview)inspections++;
 try{return await new Promise((resolve,reject)=>{
  const w=new Worker(path.join(__dirname,'thread.js'),{workerData:{buffer,action,args,selection,cursor,records},resourceLimits:{maxOldGenerationSizeMb:512,maxYoungGenerationSizeMb:32,stackSizeMb:4}});
  let settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);w.terminate().then(()=>error?reject(error):resolve(value),reject);};
  const abort=()=>finish(signal.reason||fail('DOCUMENT_JOB_INTERRUPTED'));
  const timer=setTimeout(()=>finish(fail('DOCUMENT_JOB_TIMEOUT')),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  w.on('message',async m=>{if(settled)return;try{if(m.type==='chunk'){await onChunk(m.chunk);if(!settled)w.postMessage({type:'ack'});}else if(m.type==='error')finish(fail(m.code));else if(m.type==='done')finish(null,m.value);else finish(fail('DOCUMENT_CHECKPOINT_INVALID'));}catch(e){finish(e);}});
  w.on('error',()=>finish(fail('DOCUMENT_WORKER_CRASH')));w.on('exit',()=>{if(!settled)finish(fail('DOCUMENT_WORKER_CRASH'));});
 });}finally{if(preview)inspections--;}
}
module.exports={run};
