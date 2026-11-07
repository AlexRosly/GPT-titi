const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const queue = require('../../src/services/files/preparationQueue');
const Job = require('../../src/models/filePreparation');
const File = require('../../src/models/managedFile');
const Quota = require('../../src/models/fileQuota');
const Chunk = require('../../src/models/fileChunk');
const Models = require('../../src/models/chatModels');
const store = require('../../src/services/files/store');
const processOcr = require('../../src/services/files/ocrProcess');
const uri = process.env.FILES_TEST_MONGO_URI;
let user, file;
process.env.PRIVATE_FILES_ENABLED='true'; process.env.FILE_PREPARATION_V2_ENABLED='true'; process.env.OCR_ENABLED='true';
test.before(async()=>{
  if(!uri)return;
  if(!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri))throw new Error('Dedicated files test database required');
  await mongoose.connect(uri);
  await Promise.all([Job.init(),File.init(),Quota.init(),Chunk.init()]);
  user=new mongoose.Types.ObjectId();
  await Models.collection.insertOne({modelId:'queue-test-model',enabled:true});
});
test.after(async()=>{if(uri){await mongoose.connection.dropDatabase();await mongoose.disconnect();}});
test.beforeEach(async()=>{
  if(!uri)return;
  await Job.deleteMany({});
  file=await store.create({user,name:'scan.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-test')});
});
test.afterEach(async()=>{if(uri)await store.remove(user,String(file._id));});
const integration=(name,fn)=>test(name,{skip:!uri},fn);
const result=options=>options?.page==='inspect'?{totalPages:1,manifest:[{page:1,ocr:true}]}:({text:'[PDF PAGE 1 OF 1 — OCR]\nRecognized text 731',pages:1,languages:'eng',detections:[{page:1,models:['eng'],script:'Latin',uncertain:false}]});
integration('concurrent enqueue and worker claims recognize once; repeated poll/retry adds no quota or model calls',async t=>{
  let calls=0;t.mock.method(processOcr,'extract',async(b,k,o)=>{calls++;return result(o);});
  const states=await Promise.all([1,2,3].map(()=>queue.enqueue(user,String(file._id),'queue-test-model')));
  assert.ok(states.every(s=>s.status==='queued'));assert.equal(await Job.countDocuments(),1);
  await Promise.all([queue.runOnce(),queue.runOnce()]);
  assert.equal(calls,2);
  const bytes=(await Quota.findById(user)).bytes;
  assert.equal((await queue.status(user,String(file._id),'queue-test-model')).status,'ready');
  assert.equal((await queue.enqueue(user,String(file._id),'queue-test-model',true)).status,'ready');
  await queue.runOnce();assert.equal(calls,2);assert.equal((await Quota.findById(user)).bytes,bytes);
  await assert.rejects(queue.status(new mongoose.Types.ObjectId(),String(file._id),'queue-test-model'),{fileError:'FILE_NOT_FOUND'});
});
integration('expired running lease resumes, reuses completed cache, and never recognizes that cache again',async t=>{
  const extract=t.mock.method(processOcr,'extract',async(b,k,o)=>result(o));
  await queue.enqueue(user,String(file._id),'queue-test-model');
  await Job.updateOne({file:file._id},{$set:{status:'running',attempts:1,leaseToken:'dead-worker',leaseUntil:new Date(0)}});
  await queue.runOnce(); assert.equal(extract.mock.callCount(),2);
  const bytes=(await Quota.findById(user)).bytes;
  await Job.updateOne({file:file._id},{$set:{status:'running',attempts:1,leaseToken:'dead-after-cache',leaseUntil:new Date(0)}});
  await queue.runOnce();assert.equal(extract.mock.callCount(),2);
  assert.equal((await Quota.findById(user)).bytes,bytes);
});
integration('cancel fences an in-flight result; explicit retry reuses upload and can complete',async t=>{
  let release,started;
  const ready=new Promise(r=>{started=r;});const wait=new Promise(r=>{release=r;});
  const extract=t.mock.method(processOcr,'extract',async(b,k,o)=>{started();await wait;return result(o);});
  await queue.enqueue(user,String(file._id),'queue-test-model');
  const running=queue.runOnce();await ready;
  await queue.cancel(user,String(file._id));release();await running;
  assert.equal((await Job.findOne({file:file._id})).status,'cancelled');
  assert.equal((await File.findById(file._id)).ocrCache,null);
  assert.equal((await Quota.findById(user)).bytes,file.size);
  extract.mock.mockImplementation(async(b,k,o)=>result(o));
  await queue.enqueue(user,String(file._id),'queue-test-model',true);await queue.runOnce();
  assert.equal((await queue.status(user,String(file._id),'queue-test-model')).status,'ready');
});
integration('deletion, model opt-out and attempts cap prevent expensive work',async t=>{
  const extract=t.mock.method(processOcr,'extract',async(b,k,o)=>result(o));
  await queue.enqueue(user,String(file._id),'queue-test-model');
  await Models.updateOne({modelId:'queue-test-model'},{$set:{ocrInputEnabled:false}});
  await queue.runOnce();assert.equal(extract.mock.callCount(),0);
  await Models.updateOne({modelId:'queue-test-model'},{$unset:{ocrInputEnabled:1}});
  await Job.updateOne({file:file._id},{$set:{status:'running',attempts:3,leaseUntil:new Date(0)}});
  await queue.runOnce();assert.equal((await Job.findOne({file:file._id})).status,'failed');
  assert.equal((await queue.enqueue(user,String(file._id),'queue-test-model',true)).retryable,false);
  assert.equal(extract.mock.callCount(),0);
  await Job.updateOne({file:file._id},{$set:{status:'queued',attempts:0}});
  await store.remove(user,String(file._id));await queue.runOnce();assert.equal(extract.mock.callCount(),0);
});
integration('page checkpoint survives worker failure; retry skips saved page and deletion refunds all derived quota',async t=>{
 const seen=[];
 const native=t.mock.method(processOcr,'extract',async(b,k,o)=>{
   seen.push(o.page);
   if(o.page==='inspect')return {totalPages:2,manifest:[{page:1,ocr:true},{page:2,ocr:true}]};
   if(o.page===2)throw Object.assign(new Error(),{fileError:'OCR_FAILED'});
   return {...result(o),text:'[PDF PAGE 1 OF 2 — OCR]\nPAGE ONE'};
 });
 await queue.enqueue(user,String(file._id),'queue-test-model');await queue.runOnce();
 const partial=await File.findById(file._id);assert.equal(partial.ocrProgress.completed.length,1);assert.equal(partial.ocrCache,null);
 assert.equal((await queue.status(user,String(file._id),'queue-test-model')).progress.completedPages,1);
 const before=seen.filter(x=>x===1).length;
 native.mock.mockImplementation(async(b,k,o)=>{assert.equal(o.page,2);return {...result(o),text:'[PDF PAGE 2 OF 2 — OCR]\nPAGE TWO',detections:[{page:2,models:['eng']}]};});
 await queue.enqueue(user,String(file._id),'queue-test-model',true);await queue.runOnce();
 const final=await File.findById(file._id);assert.equal(final.ocrProgress,null);assert.match(final.ocrCache.text,/PAGE ONE[\s\S]*PAGE TWO/);assert.equal(seen.filter(x=>x===1).length,before);
 const quotaBefore=(await Quota.findById(user)).bytes;
 await store.remove(user,String(file._id));assert.equal((await Quota.findById(user)).bytes,quotaBefore-final.size-final.derivedBytes);
});
integration('global OCR slots enforce two jobs and one active job per user',async()=>{
 const slots=require('../../src/services/files/ocrSlots');await slots.init();
 const a=await slots.acquire(user,'one');
 await assert.rejects(slots.acquire(user,'two'),{fileError:'OCR_PROCESSING_BUSY'});
 const b=await slots.acquire(new mongoose.Types.ObjectId(),'two');
 await assert.rejects(slots.acquire(new mongoose.Types.ObjectId(),'three'),{fileError:'OCR_PROCESSING_BUSY'});
 await slots.release(a,'one');await slots.release(b,'two');
});
integration('cancel after page one retains private progress and retry does not rerun that page',async t=>{
 let release,started;const ready=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 const native=t.mock.method(processOcr,'extract',async(b,k,o)=>{
   if(o.page==='inspect')return {totalPages:2,manifest:[{page:1,ocr:true},{page:2,ocr:true}]};
   if(o.page===2){started();await wait;}
   return {...result(o),text:`[PDF PAGE ${o.page} OF 2 — OCR]\nPAGE ${o.page}`,detections:[{page:o.page,models:['eng']}]};
 });
 await queue.enqueue(user,String(file._id),'queue-test-model');const running=queue.runOnce();await ready;
 await queue.cancel(user,String(file._id));release();await running;
 const partial=await File.findById(file._id);assert.equal(partial.ocrProgress.completed.length,1);assert.equal(partial.ocrCache,null);
 native.mock.mockImplementation(async(b,k,o)=>{assert.equal(o.page,2);return {...result(o),text:'[PDF PAGE 2 OF 2 — OCR]\nPAGE 2',detections:[{page:2,models:['eng']}]};});
 await queue.enqueue(user,String(file._id),'queue-test-model',true);await queue.runOnce();
 assert.equal((await queue.status(user,String(file._id),'queue-test-model')).status,'ready');
});

integration('regional profile upgrades an old cache once and preserves raw alternatives and quota on reread',async t=>{
 const prior=process.env.OCR_REGIONS_ENABLED;
 try {
 delete process.env.OCR_REGIONS_ENABLED;
 let calls=0;
 t.mock.method(processOcr,'extract',async(b,k,o)=>{calls++;const r=result(o);if(o.page!=='inspect'&&process.env.OCR_REGIONS_ENABLED==='true')r.text+='\n[OCR REGION ALTERNATIVES — unverified]\n{"line":1,"original":"source","alternative":"Ελληνικά","crossCheck":{"status":"conflict","readings":[{"psm":7,"text":"Ελληνικά"},{"psm":13,"text":"Ελληνικό"}]}}';return r;});
 await queue.enqueue(user,String(file._id),'queue-test-model');await queue.runOnce();assert.equal(calls,2);
 await File.updateOne({_id:file._id},{$set:{'ocrCache.regionProfile':'regions-3'}});
 process.env.OCR_REGIONS_ENABLED='true';assert.equal((await queue.status(user,String(file._id),'queue-test-model')).status,'not_started');
 await queue.enqueue(user,String(file._id),'queue-test-model');await queue.runOnce();assert.equal(calls,4);
 const saved=await File.findById(file._id).lean();assert.equal(saved.ocrCache.regionProfile,'regions-4');assert.match(saved.ocrCache.text,/Ελληνικά/);assert.match(saved.ocrCache.text,/"status":"conflict"/);assert.match(saved.ocrCache.text,/Ελληνικό/);
 const quota=(await Quota.findById(user)).bytes;
 assert.equal((await queue.enqueue(user,String(file._id),'queue-test-model')).status,'ready');await queue.runOnce();assert.equal(calls,4);
 assert.equal((await File.findById(file._id)).ocrCache.text,saved.ocrCache.text);assert.equal((await Quota.findById(user)).bytes,quota);
 }finally{if(prior===undefined)delete process.env.OCR_REGIONS_ENABLED;else process.env.OCR_REGIONS_ENABLED=prior;}
});
integration('regional page checkpoints survive interruption without rerunning completed pages',async t=>{
 const prior=process.env.OCR_REGIONS_ENABLED;
 try {
 process.env.OCR_REGIONS_ENABLED='true';let interrupt=true;const calls=[];
 t.mock.method(processOcr,'extract',async(b,k,o)=>{calls.push(o.page);if(o.page==='inspect')return {totalPages:2,manifest:[1,2].map(page=>({page,ocr:true}))};
 if(o.page===2&&interrupt)throw Object.assign(new Error(),{fileError:'PREPARATION_INTERRUPTED'});
 return {text:`[PDF PAGE ${o.page} OF 2 — OCR]\nprimary ${o.page}\n[OCR REGION ALTERNATIVES — unverified]\nalternative ${o.page}`,pages:1,detections:[{page:o.page,models:['script/Latin'],regions:{alternatives:1}}]};});
 await queue.enqueue(user,String(file._id),'queue-test-model');await queue.runOnce();
 const partial=await File.findById(file._id).lean();assert.equal(partial.ocrProgress.regionProfile,'regions-4');assert.equal(partial.ocrProgress.completed.length,1);
 interrupt=false;await queue.enqueue(user,String(file._id),'queue-test-model',true);await queue.runOnce();
 assert.deepEqual(calls,['inspect',1,2,2]);const final=await File.findById(file._id).lean();assert.equal(final.ocrCache.regionProfile,'regions-4');assert.equal(final.ocrProgress,null);
 assert.ok(final.ocrCache.text.indexOf('alternative 1')<final.ocrCache.text.indexOf('alternative 2'));
 }finally{if(prior===undefined)delete process.env.OCR_REGIONS_ENABLED;else process.env.OCR_REGIONS_ENABLED=prior;}
});
