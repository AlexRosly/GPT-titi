const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
const {limits,fail}=require('./policy');
const env=()=>Object.fromEntries(['PATH','HOME','DOCKER_HOST','DOCKER_CONTEXT','XDG_RUNTIME_DIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
function args(name,l){return ['run','--pull=never','--rm','-i','--name',name,'--init','--network=none','--read-only','--user=10001:10001','--tmpfs',`/work:rw,nosuid,nodev,noexec,size=${l.tmpMiB}m,uid=10001,gid=10001,mode=0700`,'--shm-size=1m',`--memory=${l.memoryMiB}m`,`--memory-swap=${l.memoryMiB}m`,'--cpus=1','--pids-limit=64','--ulimit=core=0:0','--ulimit=nofile=128:128','--ulimit=fsize=268435456:268435456','--cap-drop=ALL','--security-opt=no-new-privileges','--log-driver=none','gptiti-compute:26'];}
async function run(request,signal,dependencies={}) {
  const spawnProcess=dependencies.spawn||spawn,l=limits(),name='gptiti-compute-'+crypto.randomUUID();
  if(signal?.aborted)throw fail('COMPUTE_ABORTED');
  const wire=JSON.stringify({...request,memoryMiB:l.memoryMiB});if(Buffer.byteLength(wire)>38*1024**2)throw fail('COMPUTE_FILE_LIMIT');
  return new Promise((resolve,reject)=>{
    let finished=false,bytes=0,exitCode=null;const chunks=[];
    const child=spawnProcess('docker',args(name,l),{stdio:['pipe','pipe','ignore'],env:env()});
    const finish=(error,result)=>{
      if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      child.stdin.destroy();child.kill('SIGKILL');
      // Do not release the server slot until cleanup completes (or bounded timeout).
      const cleanup=spawnProcess('docker',['rm','-f',name],{stdio:'ignore',env:env()});
      let ended=false;const done=(confirmed)=>{if(ended)return;ended=true;clearTimeout(cleanTimer);if(!confirmed&&exitCode!==0)return reject(Object.assign(error||fail('COMPUTE_CLEANUP_PENDING'),{cleanupUnconfirmed:true}));error?reject(error):resolve(result);};
      const cleanTimer=setTimeout(()=>{cleanup.kill('SIGKILL');done(false);},5000);
      cleanup.on('error',()=>done(false));cleanup.on('close',code=>done(code===0));
    };
    const abort=()=>finish(fail('COMPUTE_ABORTED'));
    const timer=setTimeout(()=>finish(fail('COMPUTE_TIMEOUT')),Math.min(l.runMs,request.timeoutMs)+5000);
    signal?.addEventListener('abort',abort,{once:true});
    child.on('error',()=>finish(fail('COMPUTE_UNAVAILABLE')));
    child.stdin.on('error',()=>finish(fail('COMPUTE_UNAVAILABLE')));
    child.stdout.on('data',data=>{bytes+=data.length;if(bytes>36*1024**2)return finish(fail('COMPUTE_OUTPUT_LIMIT'));chunks.push(data);});
    child.on('close',code=>{
      exitCode=code;
      if(finished)return;
      if(code!==0)return finish(fail('COMPUTE_EXECUTION_FAILED'));
      try{const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(typeof r.ok!=='boolean'||typeof r.text!=='string'||Buffer.byteLength(r.text)>65536||!Array.isArray(r.exports)||r.exports.length>10)throw Error();finish(null,r);}catch{finish(fail('COMPUTE_INVALID_RESULT'));}
    });
    child.stdin.end(wire);
  });
}
module.exports={run,args};
