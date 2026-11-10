const {Worker}=require('node:worker_threads');
const path=require('node:path');
const {fail}=require('../files/validation');
let active=0;
async function run(buffer,action,args,signal,timeoutMs=10000){
 signal?.throwIfAborted();
 if(active>=2)throw fail('DOCX_PROCESSING_BUSY');
 active++;
 try{return await new Promise((resolve,reject)=>{
  const worker=new Worker(path.join(__dirname,'worker.js'),{workerData:{buffer,action,args},resourceLimits:{maxOldGenerationSizeMb:192,maxYoungGenerationSizeMb:16,stackSizeMb:4}});
  let done=false;
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate().then(()=>error?reject(error):resolve(result),reject);};
  const abort=()=>finish(fail('COMPUTE_ABORTED'));
  const timer=setTimeout(()=>finish(fail('DOCX_PROCESSING_TIMEOUT')),Math.max(1,Math.min(10000,timeoutMs)));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  worker.on('message',r=>finish(r.error?fail(r.error):null,r));worker.on('error',()=>finish(fail('DOCX_EDIT_FAILED')));worker.on('exit',()=>finish(fail('DOCX_EDIT_FAILED')));
 });}finally{active--;}
}
module.exports={run};
