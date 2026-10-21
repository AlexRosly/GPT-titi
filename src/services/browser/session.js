const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { broker } = require('./network');
const { LIMITS } = require('./policy');
const { fail } = require('../web/policy');
let active = 0;
const dockerEnv = () => Object.fromEntries(["PATH","HOME","DOCKER_HOST","DOCKER_CONTEXT","XDG_RUNTIME_DIR"].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
function create(seeds, signal, dependencies = {}) {
  if (active >= 2) throw fail('BROWSER_BUSY');
  active++;
  const name = 'gptiti-browser-' + crypto.randomUUID();
  // No host mounts, credentials, network, or shell interpolation.
  const child = spawn('docker', ['run', '--pull=never', '--rm', '-i', '--name', name,
    '--init', '--network=none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=256m',
    '--shm-size=128m', '--memory=768m', '--memory-swap=768m', '--cpus=1', '--pids-limit=160',
    '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--security-opt=seccomp=' + require('node:path').resolve(__dirname, '../../../browser-worker/seccomp.json'),
    'gptiti-browser:21'], { stdio: ['pipe','pipe','ignore'], env: dockerEnv() });
  let closed = false, buffer = '', sequence = 0; const pending = new Map(), warnings = new Set();
  const network = (dependencies.broker || broker)(seeds, signal);
  const write = value => { if (!closed) child.stdin.write(JSON.stringify(value) + '\n'); };
  const close = () => {
    if (closed) return; closed = true; active--; clearTimeout(timer);
    signal?.removeEventListener('abort', close);
    child.stdin.destroy(); child.kill('SIGKILL');
    const cleanup = spawn('docker', ['rm','-f', name], { stdio: 'ignore', env: dockerEnv() });
    cleanup.on('error', () => {});
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(fail('BROWSER_UNAVAILABLE')); }
    pending.clear();
  };
  const timer = setTimeout(close, LIMITS.durationMs);
  child.stdin.on('error', close);
  child.on('error', error => { console.error('BROWSER_PROCESS_ERROR', {code:error.code || 'SPAWN_FAILED'}); close(); });
  child.on('exit', code => { if (!closed && code) console.error('BROWSER_PROCESS_EXIT', {code}); close(); });
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) return close();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,index); buffer = buffer.slice(index+1);
      let m; try { m = JSON.parse(line); } catch { close(); return; }
      if (m.type === 'fetch') {
        network(m).then(result => write({ type:'resource', id:m.id, ...result }),
          error => { warnings.add(error.webError || 'WEB_UNAVAILABLE'); write({ type:'resource', id:m.id, error:error.webError || 'WEB_UNAVAILABLE' }); });
      } else if (m.type === 'result') {
        const p = pending.get(m.id); if (!p) continue;
        clearTimeout(p.timer); pending.delete(m.id);
        if (m.error) p.reject(fail('BROWSER_UNAVAILABLE'));
        else if (!m.result || typeof m.result.text !== 'string' || Buffer.byteLength(m.result.text) > LIMITS.textBytes || !Array.isArray(m.result.controls) || m.result.controls.length > LIMITS.controls) p.reject(fail('BROWSER_UNAVAILABLE'));
        else p.resolve({...m.result, warnings:[...warnings], truncated:m.result.truncated || warnings.size > 0});
      }
    }
  });
  if (signal?.aborted) close(); else signal?.addEventListener('abort', close, { once: true });
  return { close, action: (action, vision = false) => new Promise((resolve,reject) => {
    if (closed) return reject(fail('BROWSER_UNAVAILABLE'));
    const id = ++sequence;
    pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(fail('BROWSER_TIMEOUT')); close(); }, 30000) });
    write({ type:'action', id, action, vision });
  }) };
}
module.exports = { create };
