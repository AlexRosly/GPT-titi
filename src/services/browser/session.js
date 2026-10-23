const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { broker } = require('./network');
const { LIMITS } = require('./policy');
const { fail } = require('../web/policy');
const errors = require('../../../browser-worker/errors');
let active = 0;
const dockerEnv = () => Object.fromEntries(['PATH','HOME','DOCKER_HOST','DOCKER_CONTEXT','XDG_RUNTIME_DIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
function create(seeds, signal, dependencies = {}) {
  if (active >= 2) throw fail('BROWSER_BUSY');
  const spawnProcess = dependencies.spawn || spawn;
  const name = 'gptiti-browser-' + crypto.randomUUID();
  const started = Date.now();
  const child = spawnProcess('docker', ['run', '--pull=never', '--rm', '-i', '--name', name,
    '--init', '--network=none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=256m',
    '--shm-size=128m', '--memory=768m', '--memory-swap=768m', '--cpus=1', '--pids-limit=160',
    '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--security-opt=seccomp=' + require('node:path').resolve(__dirname, '../../../browser-worker/seccomp.json'),
    'gptiti-browser:23'], { stdio: ['pipe','pipe','ignore'], env: dockerEnv() });
  active++;
  let closed = false, buffer = '', sequence = 0, terminal;
  const pending = new Map(), warnings = new Set();
  const network = (dependencies.broker || broker)(seeds, signal);
  const errorFor = (value, action, extra = {}) => {
    const diagnostic = { ...errors.safe(value), actionIndex:action?.id || sequence,
      kind: ['open','follow','expand','tab','search','scroll','back'].includes(action?.kind) ? action.kind : 'unknown',
      elapsedMs:Date.now()-started, ...extra };
    return Object.assign(fail(errors.code(diagnostic.reason)), {browserSessionDiagnostic:diagnostic});
  };
  const close = (reason, extra = {}) => {
    if (closed) return;
    closed = true; active--; clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    terminal = errorFor({reason:reason || 'ABORTED',stage:'session'},null,extra);
    child.stdin.destroy(); child.kill('SIGKILL');
    try { const cleanup = spawnProcess('docker', ['rm','-f',name], {stdio:'ignore',env:dockerEnv()}); cleanup.on('error',()=>{}); } catch { /* Original failure remains authoritative. */ }
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(errorFor({reason:reason || 'ABORTED',stage:'session'},p,extra)); }
    pending.clear();
  };
  const onAbort = () => close(signal?.reason?.webError === 'BROWSER_TIMEOUT' ? 'SESSION_TIMEOUT' : 'ABORTED');
  const timer = setTimeout(()=>close('SESSION_TIMEOUT'), LIMITS.durationMs);
  const write = value => {
    if (closed) return;
    try { child.stdin.write(JSON.stringify(value)+'\n'); } catch { close('STDIN_ERROR'); }
  };
  child.stdin.on('error',()=>close('STDIN_ERROR'));
  child.on('error',()=>close('SPAWN_FAILED'));
  child.on('exit',(code,signal)=>close('PROCESS_EXIT', {
    exitCode:Number.isInteger(code)?code:null,
    signal:['SIGKILL','SIGTERM','SIGTRAP','SIGSEGV','SIGABRT'].includes(signal)?signal:null
  }));
  child.stdout.on('data',chunk=>{
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer)>2*1024*1024) return close('RESPONSE_TOO_LARGE');
    let index;
    while ((index=buffer.indexOf('\n'))>=0) {
      const line=buffer.slice(0,index); buffer=buffer.slice(index+1);
      let m; try { m=JSON.parse(line); } catch { close('PROTOCOL_ERROR'); return; }
      if (!m || typeof m !== 'object') { close('PROTOCOL_ERROR'); return; }
      if (m.type==='fetch') {
        network(m).then(result=>write({type:'resource',id:m.id,...result}), error=>{
          warnings.add(error.webError || 'WEB_UNAVAILABLE');
          write({type:'resource',id:m.id,error:error.webError || 'WEB_UNAVAILABLE'});
        });
      } else if (m.type==='result') {
        const p=pending.get(m.id); if (!p) continue;
        clearTimeout(p.timer); pending.delete(m.id);
        if (m.error) p.reject(errorFor(m.diagnostic,p));
        else if (!m.result || typeof m.result.text!=='string' || Buffer.byteLength(m.result.text)>LIMITS.textBytes || !Array.isArray(m.result.controls) || m.result.controls.length>LIMITS.controls) p.reject(errorFor({reason:'RESPONSE_INVALID',stage:'observe'},p));
        else p.resolve({...m.result,warnings:[...warnings],truncated:m.result.truncated || warnings.size>0});
      } else { close('PROTOCOL_ERROR'); return; }
    }
  });
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort',onAbort,{once:true});
  return { close:()=>close(), action:(action,vision=false)=>new Promise((resolve,reject)=>{
    if (closed) return reject(terminal || fail('BROWSER_UNAVAILABLE'));
    const id=++sequence;
    pending.set(id,{id,kind:action.kind,resolve,reject,timer:setTimeout(()=>{
      const p=pending.get(id); if (!p) return;
      pending.delete(id); reject(errorFor({reason:'ACTION_TIMEOUT',stage:'session'},p)); close('ACTION_TIMEOUT');
    },30000)});
    write({type:'action',id,action,vision});
  }) };
}
module.exports = { create };
