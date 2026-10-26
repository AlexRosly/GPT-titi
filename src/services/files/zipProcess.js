const {Worker}=require('node:worker_threads');const path=require('node:path');const {fail}=require('./validation');
let active=0;
module.exports=async function processZip(data){
 if(active>=2)throw fail('ZIP_PROCESSING_BUSY',503);active++;
 try{return await new Promise((resolve,reject)=>{
  const worker=new Worker(path.join(__dirname,'zipWorker.js'),{workerData:data,resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:16,stackSizeMb:4}});
  let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);worker.terminate().then(()=>error?reject(error):resolve(value),reject);};
  const timer=setTimeout(()=>finish(fail('ZIP_PROCESSING_TIMEOUT',413)),10000);
  worker.once('message',r=>finish(r.error?fail(r.error,422):null,r));worker.once('error',()=>finish(fail('INVALID_ZIP')));worker.once('exit',()=>{if(!settled)finish(fail('INVALID_ZIP'));});
 });}finally{active--;}
};
