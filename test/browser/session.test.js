const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {create}=require('../../src/services/browser/session');
const errors=require('../../browser-worker/errors');
function fixture(t) {
  const child=new EventEmitter(); child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
  const calls=[];
  const session=create(['https://example.com/'],undefined,{spawn:(...args)=>{calls.push(args);return calls.length===1?child:new EventEmitter();},broker:()=>async()=>({})});
  t.after(()=>session.close());
  return {child,session,calls,send:m=>child.stdout.write(JSON.stringify(m)+'\n')};
}
test('runner failure categories never return raw messages or URLs',()=>{
  assert.equal(errors.category({name:'TimeoutError',message:'secret https://private/'}),'ACTION_TIMEOUT');
  assert.equal(errors.category(new Error('page.goto: net::ERR_FAILED secret')),'NAVIGATION_FAILED');
  assert.equal(errors.category(new Error('Target page, context or browser has been closed')),'PAGE_CLOSED');
  assert.deepEqual(errors.safe({reason:'SECRET',stage:'https://private',message:'SECRET'}),{reason:'WORKER_FAILURE',stage:'session'});
});
test('session preserves safe worker category, action and index without raw diagnostics',async t=>{
  const f=fixture(t);const pending=f.session.action({kind:'follow',ref:'b2'});
  f.send({type:'result',id:1,error:'anything',diagnostic:{reason:'NAVIGATION_FAILED',stage:'navigate',message:'SECRET',url:'PRIVATE'}});
  await assert.rejects(pending,e=>{
    assert.equal(e.webError,'BROWSER_NAVIGATION_FAILED');assert.equal(e.browserSessionDiagnostic.actionIndex,1);assert.equal(e.browserSessionDiagnostic.kind,'follow');
    assert.ok(!JSON.stringify(e).includes('SECRET'));return true;
  });
  assert.ok(f.calls[0][1].includes('gptiti-browser:23'));
  for(const flag of ['--network=none','--cap-drop=ALL','--security-opt=no-new-privileges']) assert.ok(f.calls[0][1].includes(flag));
});
test('unexpected process death preserves exit/signal; cleanup is idempotent',async t=>{
  const f=fixture(t);const pending=f.session.action({kind:'open',url:'https://example.com/'});
  f.child.emit('exit',137,'SIGKILL');
  await assert.rejects(pending,e=>e.browserSessionDiagnostic.reason==='PROCESS_EXIT' && e.browserSessionDiagnostic.exitCode===137 && e.browserSessionDiagnostic.signal==='SIGKILL');
  f.session.close();assert.equal(f.calls.length,2);
});
test('malformed output and legacy worker errors fail closed with diagnostic',async t=>{
  const f=fixture(t);const p=f.session.action({kind:'scroll'});f.child.stdout.write('bad json\n');
  await assert.rejects(p,e=>e.browserSessionDiagnostic.reason==='PROTOCOL_ERROR');
  const g=fixture(t);const q=g.session.action({kind:'scroll'});g.send({type:'result',id:1,error:'BROWSER_UNAVAILABLE'});
  await assert.rejects(q,e=>e.browserSessionDiagnostic.reason==='WORKER_FAILURE');
});
test('main-document broker categories distinguish limits, access and policy rejection',()=>{
  for(const [message,reason,code] of [
    ['BROWSER_LIMIT','RESOURCE_LIMIT','BROWSER_LIMIT'],
    ['WEB_PAGE_TOO_LARGE','RESOURCE_LIMIT','BROWSER_LIMIT'],
    ['BROWSER_ACTION_BLOCKED','NETWORK_POLICY_BLOCKED','BROWSER_ACTION_BLOCKED'],
    ['WEB_ACCESS_DENIED','HTTP_ACCESS_DENIED','BROWSER_NAVIGATION_FAILED'],
    ['WEB_UNSUPPORTED_TYPE','UNSUPPORTED_DOCUMENT','WEB_UNSUPPORTED_TYPE'],
    ['WEB_TIMEOUT','ACTION_TIMEOUT','BROWSER_TIMEOUT']
  ]) { assert.equal(errors.category(new Error(message)),reason);assert.equal(errors.code(reason),code); }
});
