const test = require('node:test');
const assert = require('node:assert/strict');
const queue = require('../../src/services/files/preparationQueue');
const ocr = require('../../src/services/files/ocrInput');
const processOcr = require('../../src/services/files/ocrProcess');
const store = require('../../src/services/files/store');
const Job = require('../../src/models/filePreparation');
const Models = require('../../src/models/chatModels');
const file = () => ({ _id: '0123456789abcdef01234567', user: 'owner', originalName: 'scan.pdf', mimetype: 'application/pdf', size: 100, checksum: 'checksum' });
process.env.PRIVATE_FILES_ENABLED = 'true'; process.env.FILE_PREPARATION_V2_ENABLED = 'true'; process.env.OCR_ENABLED = 'true';
test('DTO exposes polling state without private text, lease or worker internals', () => {
  const result = queue.dto(file(), { status:'running', attempts:1, leaseToken:'secret', errorCode:'secret' });
  assert.deepEqual(result,{status:'running',method:'local_ocr',attempts:1,pollAfterMs:2000});
  assert.equal(queue.dto(file(),{status:'failed',attempts:3,errorCode:'OCR_FAILED'}).retryable,false);
  assert.equal(queue.dto(file(),{status:'failed',attempts:1,errorCode:'OCR_FAILED'}).retryable,true);
  assert.equal(queue.dto(file(),{status:'failed',attempts:1,errorCode:'PDF_PASSWORD_PROTECTED'}).retryable,false);
  assert.deepEqual(queue.dto({...file(),mimetype:'text/plain'}),{status:'not_required'});
});
test('completed cache wins over stale job state and never reveals recognized text in status', () => {
  const f = {...file(),ocrCache:{version:3,qualityRevision:2,checksum:'checksum',text:'private text',pages:1,detections:[{script:'Latin',uncertain:true}]}};
  assert.deepEqual(queue.dto(f,{status:'running',attempts:1}),{status:'ready',method:'local_ocr',ocrPages:1,textBytes:12,scripts:['Latin'],uncertain:true});
});
test('foreign file and model opt-out are rejected before any enqueue', async t => {
  const enqueue = t.mock.method(Job,'findOneAndUpdate',()=>{throw new Error('must not enqueue');});
  const owned = t.mock.method(store,'owned',async()=>{throw Object.assign(new Error(),{fileError:'FILE_NOT_FOUND'});});
  await assert.rejects(queue.enqueue('other',String(file()._id),'model'),{fileError:'FILE_NOT_FOUND'});
  owned.mock.mockImplementation(async()=>file());
  t.mock.method(Models,'findOne',()=>({lean:async()=>({enabled:true,ocrInputEnabled:false})}));
  await assert.rejects(queue.enqueue('owner',String(file()._id),'model'),{fileError:'OCR_INPUT_DISABLED'});
  assert.equal(enqueue.mock.callCount(),0);
});
test('queued worker claims with lease, fences OCR commit, and finalizes once', async t => {
  const f=file();
  t.mock.method(store,'owned',async()=>f);
  t.mock.method(Models,'findOne',()=>({lean:async()=>({enabled:true})}));
  t.mock.method(Job,'updateMany',async()=>({}));
  let token;
  t.mock.method(Job,'findOneAndUpdate',(filter,update)=>{token=update.$set.leaseToken;return {lean:async()=>({_id:'job',user:'owner',file:f._id,checksum:f.checksum,modelId:'model',attempts:1})};});
  const updates=[];
  t.mock.method(Job,'updateOne',async (filter,update,options)=>{updates.push({filter,update,options});return {matchedCount:1};});
  const session={test:'session'};
  const prepare=t.mock.method(ocr,'prepare',async (user,id,model,options)=>{assert.equal(options.signal.aborted,false); await options.beforeCommit(session);});
  assert.equal(await queue.runOnce(),true);
  assert.equal(prepare.mock.callCount(),1);
  assert.ok(updates.some(u=>u.options?.session===session));
  assert.equal(updates.at(-1).update.$set.status,'ready');
  assert.ok(updates.every(u=>u.filter.leaseToken===token));
});
test('lost lease prevents OCR invocation and stale worker cannot update winner', async t => {
  const f=file(); t.mock.method(store,'owned',async()=>f);
  t.mock.method(Models,'findOne',()=>({lean:async()=>({enabled:true})}));
  t.mock.method(Job,'updateMany',async()=>({}));
  t.mock.method(Job,'findOneAndUpdate',()=>({lean:async()=>({_id:'job',user:'owner',file:f._id,checksum:f.checksum,modelId:'model'})}));
  t.mock.method(Job,'updateOne',async()=>({matchedCount:0}));
  const prepare=t.mock.method(ocr,'prepare',async()=>{});
  await queue.runOnce(); assert.equal(prepare.mock.callCount(),0);
});
test('already aborted recognition never starts a subprocess', async () => {
  const controller=new AbortController(); controller.abort();
  await assert.rejects(processOcr.extract(Buffer.from('data'),'pdf',{signal:controller.signal}),{name:'AbortError'});
});
test('in-flight abort terminates native OCR and releases its process slot', async () => {
  const { makeImage } = require('./fixtures/ocr');
  process.env.OCR_LANGUAGES = 'eng';
  const controller = new AbortController();
  const result = processOcr.extract(makeImage(), 'image', { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(result, error => error.name === 'AbortError' || error.fileError === 'PREPARATION_INTERRUPTED'); }
  finally { clearTimeout(timer); }
  assert.match((await processOcr.extract(makeImage(), 'image')).text, /INVOICE/);
});
test('an obsolete completed job can enqueue a fresh extraction after cache invalidation', async t => {
  t.mock.method(store,'owned',async()=>file());
  t.mock.method(Models,'findOne',()=>({lean:async()=>({enabled:true})}));
  let calls=0;
  t.mock.method(Job,'findOneAndUpdate',(filter,update)=>({lean:async()=>{
    calls++;
    if(calls===1)return {_id:'job',status:'ready',attempts:1};
    assert.equal(filter.status,'ready');assert.equal(update.$set.attempts,0);
    return {_id:'job',status:'queued',attempts:0};
  }}));
  assert.equal((await queue.enqueue('owner',file()._id,'model')).status,'queued');
  assert.equal(calls,2);
});
