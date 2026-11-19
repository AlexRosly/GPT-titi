// Every PM2 command, including kill, targets a private test daemon in a fresh
// temporary directory. The production PM2 daemon and its processes are separate.
const fs=require('node:fs/promises'),path=require('node:path');
const {promisify}=require('node:util'),exec=promisify(require('node:child_process').execFile);
const {setTimeout:sleep}=require('node:timers/promises');
module.exports=function managed(mode,dir) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PM2_')));
  env.PM2_HOME=path.join(dir,'pm2');
  const cli=(...args)=>exec('pm2',args,{env,timeout:25000,maxBuffer:1024*1024});
  let firstPid;
  async function observe(name,waitMs) {
    const until=Date.now()+waitMs;
    while(Date.now()<until){
      try{return JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      await sleep(250);
    }
    throw Error('Timed out waiting for '+name+' from the test worker');
  }
  return {
    async first(){
      await cli('start',path.join(__dirname,'restartChild.js'),'--name','docx-qa','--no-autorestart','--',mode,'managed',dir);
      const paused=await observe('checkpoint.json',60000);
      firstPid=paused.pid;
      return paused.checkpoint;
    },
    async second(){
      await cli('restart','docx-qa');
      const done=await observe('finished.json',270000);
      if(!firstPid||!done.pid||done.pid===firstPid)throw Error('PM2 did not launch a fresh worker');
      return {firstPid,resumedPid:done.pid};
    },
    async close(){await cli('kill');}
  };
};
