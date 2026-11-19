const {fork}=require('node:child_process'),path=require('node:path');
module.exports=function runChild(mode,stage,dir=''){
  return new Promise((resolve,reject)=>{
    let checkpoint=null;
    const child=fork(path.join(__dirname,'restartChild.js'),[mode,stage,dir],{stdio:['ignore','inherit','inherit','ipc']});
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Timed out waiting for '+stage));},120000);
    child.on('message',message=>{
      if(stage==='first'&&message.checkpoint===1500){checkpoint=1500;child.kill('SIGKILL');}
    });
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('exit',(code,signal)=>{
      clearTimeout(timer);
      if(stage==='first'?checkpoint===1500&&signal==='SIGKILL':code===0)resolve(checkpoint);
      else reject(Error('Unexpected child exit '+code+'/'+signal));
    });
  });
};
