// Runs real Docker/Python. No paid model or MongoDB is used.
const test=require('node:test'),assert=require('node:assert/strict');
const {run}=require('../../src/services/computation/session');
const base={files:[],exports:[],timeoutMs:15000};
async function preflight(){
 const r=await run({...base,code:"print('COMPUTE_READY')"});
 assert.equal(r.ok,true,JSON.stringify(r));assert.match(r.text,/COMPUTE_READY/);
}
// Resource-failure tests must not pass merely because the runner refuses to start.
test.before(preflight);
test('real sandbox computes with pandas, exports a plot, has no network/secrets and cannot write root', {timeout:45000},async()=>{
 const result=await run({...base,code:`import os, socket, pandas as pd, matplotlib.pyplot as plt\nassert os.getuid() == 10001\nassert not os.environ.get('OPENAI_API_KEY')\nassert not os.path.exists('/var/run/docker.sock')\ntry:\n open('/app/forbidden','w'); raise AssertionError('root writable')\nexcept OSError: pass\ns=socket.socket(); s.settimeout(1)\ntry:\n s.connect(('1.1.1.1',443)); raise AssertionError('network accessible')\nexcept OSError: pass\nassert pd.DataFrame({'v':[1,2,3]}).v.sum()==6\nplt.plot([1,2,3]); plt.savefig('/work/output/plot.png')\nprint('ISOLATED_OK 6')`,exports:[{path:'plot.png',filename:'plot.png'}]});
 assert.equal(result.ok,true,JSON.stringify(result));assert.match(result.text,/ISOLATED_OK 6/);assert.equal(result.exports.length,1);
});
test('timeouts and abort stop execution; output and symlink exports are bounded', {timeout:45000},async()=>{
 const r=await run({...base,timeoutMs:1000,code:'while True: pass'});assert.equal(r.ok,false);assert.equal(r.timeout,true,JSON.stringify(r));
 const linked=await run({...base,code:"import os\nos.symlink('/etc/passwd','/work/output/out')",exports:[{path:'out',filename:'out.txt'}]});assert.equal(linked.ok,false);assert.equal(linked.exports.length,0);
 const log=await run({...base,code:"print('x'*1000000)"});assert.equal(log.ok,true);assert.equal(log.truncated,true);assert.ok(Buffer.byteLength(log.text)<=16384);
 const c=new AbortController();const promise=run({...base,code:'import time; time.sleep(30)'},c.signal);setTimeout(()=>c.abort(),500);await assert.rejects(promise,e=>e.fileError==='COMPUTE_ABORTED');
});
test('container enforces memory and disk constraints', {timeout:45000},async()=>{
 const memory=await run({...base,code:"x=bytearray(900*1024*1024)\nprint(len(x))"}).catch(e=>{assert.equal(e.fileError,'COMPUTE_EXECUTION_FAILED');return {ok:false};});assert.equal(memory.ok,false);
 const disk=await run({...base,code:"with open('/work/huge','wb') as f:\n for i in range(300): f.write(b'x'*1024*1024)"});assert.equal(disk.ok,false);
});
