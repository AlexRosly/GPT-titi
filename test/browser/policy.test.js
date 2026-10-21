const test = require('node:test'); const assert = require('node:assert/strict');
const policy = require('../../src/services/browser/policy');
const {broker} = require('../../src/services/browser/network');
const seeds=['https://example.com/'];
test('browser defaults off, old/new model defaults on only behind server flag, opt-out wins',()=>{
  delete process.env.BROWSER_V2_ENABLED; assert.equal(policy.enabled({}),false);
  process.env.BROWSER_V2_ENABLED='true'; assert.equal(policy.enabled({}),true); assert.equal(policy.enabled({browserInputEnabled:false}),false);
  delete process.env.BROWSER_V2_ENABLED;
});
test('actions require observed typed references and user seed URLs; arbitrary selectors/code/forms rejected',()=>{
  const obs={controls:[{ref:'b1',kind:'follow'},{ref:'b2',kind:'search'}]};
  assert.deepEqual(policy.action({kind:'follow',ref:'b1'},obs,seeds),{kind:'follow',ref:'b1'});
  for(const a of [{kind:'click',selector:'#pay'},{kind:'tab',ref:'b1'},{kind:'follow',ref:'fake'},
    {kind:'open',url:'http://127.0.0.1'},{kind:'open',url:'https://other.com/'},{kind:'search',ref:'b2',query:'x'.repeat(201)},
    {kind:'scroll',code:'eval()'},{kind:'done',url:'https://example.com/'}]) assert.throws(()=>policy.action(a,obs,seeds));
});
test('network blocks methods, internal addresses and off-origin navigation before DNS/network',async()=>{
  let calls=0; const get=broker(seeds,undefined,{addressFor:async()=>{calls++;throw Error('must not run');}});
  for(const m of [{url:seeds[0],method:'POST',resourceType:'fetch'},{url:'http://127.0.0.1',method:'GET',resourceType:'image'},
    {url:'https://other.com/',method:'GET',resourceType:'document'},{url:seeds[0],method:'GET',resourceType:'websocket'}]) await assert.rejects(get(m));
  assert.equal(calls,0);
});
test('network pins each destination and removes cookies/auth; public redirects revalidated',async()=>{
  let seen; const record={address:'93.184.216.34',family:4};
  const get=broker(seeds,undefined,{addressFor:async u=>{assert.equal(u.hostname,'example.com');return record;},
    request:async(u,r)=>{seen=r;return {status:200,type:'text/html',body:Buffer.from('<p>render me</p>')};}});
  const result=await get({url:seeds[0],method:'GET',resourceType:'document'});
  assert.equal(seen,record); assert.equal(result.headers['set-cookie'],undefined); assert.match(result.headers['content-security-policy'],/form-action 'none'/);
  const redirect=broker(seeds,undefined,{addressFor:async()=>record,request:async()=>({status:302,location:'http://169.254.169.254/'})});
  await assert.rejects(redirect({url:seeds[0],method:'GET',resourceType:'document'}));
});
test('request count and concurrent download bounds stop resource floods',async()=>{
  const get=broker(seeds,undefined,{addressFor:async()=>({address:'93.184.216.34',family:4}),request:async()=>({status:200,type:'text/plain',body:Buffer.from('ok')})});
  for(let n=0;n<policy.LIMITS.requests;n++) await get({url:seeds[0],method:'GET',resourceType:'fetch'});
  await assert.rejects(get({url:seeds[0],method:'GET',resourceType:'fetch'}),e=>e.webError==='BROWSER_LIMIT');
});
test('broker admits at most eight concurrent resources and releases capacity',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const get=broker(seeds,undefined,{addressFor:async()=>{await gate;return {address:'93.184.216.34',family:4};},request:async()=>({status:200,type:'text/plain',body:Buffer.from('ok')})});
  const admitted=Array.from({length:8},()=>get({url:seeds[0],method:'GET',resourceType:'fetch'}));
  await assert.rejects(get({url:seeds[0],method:'GET',resourceType:'fetch'}),e=>e.webError==='BROWSER_LIMIT');
  release();await Promise.all(admitted);await get({url:seeds[0],method:'GET',resourceType:'fetch'});
});
