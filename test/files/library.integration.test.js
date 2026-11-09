const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const { User, ChatMessage, ChatConversation } = require('../../src/models');
const File = require('../../src/models/managedFile');
const Chunk = require('../../src/models/fileChunk');
const Quota = require('../../src/models/fileQuota');
const Job = require('../../src/models/filePreparation');
const Models = require('../../src/models/chatModels');
const store = require('../../src/services/files/store');
const messages = require('../../src/services/files/messages');
const migration = require('../../src/services/files/libraryMigration');
const uri = process.env.FILES_TEST_MONGO_URI;
let user, other, server, root, ownHeaders, otherHeaders;
process.env.PRIVATE_FILES_ENABLED='true';
process.env.FILE_PREPARATION_V2_ENABLED='true';
process.env.OCR_ENABLED='false';
test.before(async()=>{
  if (!uri) return;
  if (!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri)) throw Error('Dedicated files test database required');
  await mongoose.connect(uri);
  await Promise.all([File.init(),Chunk.init(),Quota.init(),Job.init()]);
  user=await User.create({email:'library@example.test',name:'Owner',status:'active'});
  other=await User.create({email:'other-library@example.test',name:'Other',status:'active'});
  process.env.JWT_SECRET='library-test-only';
  ownHeaders={authorization:`Bearer ${jwt.sign({userId:user.id},process.env.JWT_SECRET)}`};
  otherHeaders={authorization:`Bearer ${jwt.sign({userId:other.id},process.env.JWT_SECRET)}`};
  const app=express();app.use('/files',require('../../src/routes/files'));
  app.use((e,req,res,next)=>res.status(500).json({error:e.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  root=`http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async()=>{if(uri){await File.deleteMany({});await Chunk.deleteMany({});await Quota.deleteMany({});await Job.deleteMany({});await ChatMessage.deleteMany({});await ChatConversation.deleteMany({});}});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));if(uri){await mongoose.connection.dropDatabase();await mongoose.disconnect();}});
const integration=(name,fn)=>test(name,{skip:!uri},fn);
const create=(extra={})=>store.create({user:user._id,name:'saved.png',mimetype:'image/png',buffer:Buffer.from('private bytes'),...extra});
const list=async(headers=ownHeaders)=>{const r=await fetch(root+'/files',{headers});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');return r.json();};
integration('completed upload is permanent, model-independent, listed with quota; foreign owner gets 404',async()=>{
  const form=new FormData();form.append('file',new Blob(['hello']), 'saved.txt');
  const response=await fetch(root+'/files',{method:'POST',headers:ownHeaders,body:form});assert.equal(response.status,201);
  const {file}=await response.json();assert.equal(file.expiresAt,null);assert.equal(file.retention,'library');assert.ok(file.createdAt);
  assert.equal((await list()).quota.bytes,5);assert.equal((await list()).files.length,1);assert.equal((await list(otherHeaders)).files.length,0);
  for(const path of ['', '/download','/preview','/ocr','/preparation?modelId=test'])assert.equal((await fetch(root+'/files/'+file.fileId+path,{headers:otherHeaders})).status,404);
  assert.equal((await fetch(root+'/files/'+file.fileId,{method:'DELETE',headers:otherHeaders})).status,404);
  await store.cleanup();assert.equal((await store.read(user._id,file.fileId)).buffer.toString(),'hello');
});
integration('same ID in two chats costs one file; clearing either chat preserves original and generated files',async()=>{
  const file=await create();const generated=await create({name:'result.txt',mimetype:'text/plain',source:'generated',resultKey:'result:one'});
  const refs=await store.transaction(s=>messages.resolve(user._id,[{fileId:String(file._id)}],s));
  const before=await Quota.findById(user._id).lean();
  for(let i=0;i<2;i++){
    const chat=await ChatConversation.create({user:user._id,title:'Library reuse'});
    await store.transaction(s=>messages.resolve(user._id,[{fileId:String(file._id)}],s));
    await ChatMessage.create({user:user._id,conversation:chat._id,role:'user',content:'Keep message',attachments:refs});
    await ChatMessage.create({user:user._id,conversation:chat._id,role:'assistant',content:'Keep answer',attachments:[{...store.dto(generated),storage:'private'}]});
    await require('../../src/controllers/chat/conversation/clearConversationMessages')({params:{id:String(chat._id)},user:{id:user.id}},{json:()=>{}});
    assert.equal((await store.read(user._id,String(file._id))).buffer.toString(),'private bytes');
    assert.equal((await File.findById(generated._id)).status,'ready');
    const response={status(code){assert.equal(code,200);return this;},json(){}};
    await require('../../src/controllers/chat/conversation/archiveConversation')({params:{id:String(chat._id)},user:{id:user.id}},response);
    assert.equal((await File.findById(file._id)).status,'ready');
  }
  const after=await Quota.findById(user._id).lean();assert.equal(after.bytes,before.bytes);assert.equal(after.count,2);
  assert.equal(await ChatMessage.countDocuments(),4);
  await assert.rejects(store.transaction(s=>messages.resolve(user._id,[{fileId:String(file._id)},{fileId:String(file._id).toUpperCase()}],s)),{fileError:'INVALID_ATTACHMENTS'});
});
integration('concurrent explicit deletion refunds originals and derived quota once and preserves history',async()=>{
  const f=await create();await File.updateOne({_id:f._id},{$set:{derivedBytes:12,ocrCache:{text:'private text'}}});await Quota.updateOne({_id:user._id},{$inc:{bytes:12}});
  const chat=await ChatConversation.create({user:user._id,title:'Delete'});
  const message=await ChatMessage.create({user:user._id,conversation:chat._id,role:'assistant',content:'Historical answer',attachments:[{...store.dto(f),storage:'private'}]});
  await Promise.all([1,2,3].map(()=>store.remove(user._id,String(f._id))));
  assert.equal((await Quota.findById(user._id)).bytes,0);assert.equal((await Quota.findById(user._id)).count,0);assert.equal(await Chunk.countDocuments(),0);
  assert.equal((await File.findById(f._id)).ocrCache,null);assert.equal((await ChatMessage.findById(message._id)).content,'Historical answer');
  assert.equal((await messages.hydrate(user._id,[message]))[0].attachments[0].status,'deleted');
  assert.equal((await list()).files.length,0);
});
integration('temporary compute exports are hidden, can be published, and cleanup only removes expired temporary bytes',async()=>{
  const temp=await create({source:'generated',retention:'temporary'});const persistent=await create({source:'generated'});
  assert.equal((await list()).files.length,1);
  await File.updateOne({_id:temp._id},{$set:{retention:'library',expiresAt:null}});
  assert.equal((await list()).files.length,2);
  await store.removeTemporary(user._id,String(temp._id));assert.equal((await File.findById(temp._id)).status,'ready');
  const expired=await create({source:'generated',retention:'temporary'});await File.updateOne({_id:expired._id},{$set:{expiresAt:new Date(0)}});
  await store.cleanup();assert.equal((await File.findById(expired._id)).status,'deleted');assert.equal((await File.findById(temp._id)).status,'ready');assert.equal((await File.findById(persistent._id)).status,'ready');
});
integration('migration validates bytes, is dry-run/idempotent, preserves temporary/expired/deleted and detects quota drift',async()=>{
  const legacy=await create();await File.updateOne({_id:legacy._id},{$unset:{retention:1},$set:{expiresAt:new Date(Date.now()+86400000)}});
  const staged=await create({source:'generated',retention:'temporary'});await File.updateOne({_id:staged._id},{$unset:{retention:1}});
  const expired=await create();await File.updateOne({_id:expired._id},{$unset:{retention:1},$set:{expiresAt:new Date(0)}});
  const dead=await create();await store.remove(user._id,String(dead._id));
  const before=await Quota.findById(user._id).lean();const dry=await migration.migrate();assert.equal(dry.promoted,1);assert.equal(dry.expired,1);assert.equal(dry.deleted,1);assert.equal(dry.temporary,1);assert.deepEqual(dry.problems,[]);assert.ok((await File.findById(legacy._id)).expiresAt);
  await migration.migrate({apply:true});assert.equal((await File.findById(legacy._id)).expiresAt,null);assert.equal((await File.findById(staged._id)).retention,'temporary');assert.equal((await migration.migrate({apply:true})).promoted,0);assert.equal((await Quota.findById(user._id)).bytes,before.bytes);
  await Quota.updateOne({_id:user._id},{$inc:{bytes:99}});assert.equal((await migration.migrate()).problems[0].code,'QUOTA_MISMATCH');
  assert.equal((await migration.migrate({apply:true,repairQuota:true})).quotaRepairs,1);assert.equal((await Quota.findById(user._id)).bytes,before.bytes);
  await Chunk.updateOne({file:legacy._id},{$set:{data:Buffer.from('corrupt')}});const bad=await migration.migrate({apply:true});assert.ok(bad.problems.some(p=>p.code==='FILE_INTEGRITY_FAILED'));assert.equal(bad.promoted,0);
});
integration('deletion while OCR runs fences the job, prevents cache resurrection and refunds quota',async t=>{
  process.env.OCR_ENABLED='true';t.after(()=>{process.env.OCR_ENABLED='false';});
  await Models.collection.updateOne({modelId:'library-ocr-test'},{$set:{modelId:'library-ocr-test',enabled:true}},{upsert:true});
  const f=await create({name:'scan.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-test')});
  const queue=require('../../src/services/files/preparationQueue');const native=require('../../src/services/files/ocrProcess');
  let started,release;const ready=new Promise(r=>{started=r;});const wait=new Promise(r=>{release=r;});
  t.mock.method(native,'extract',async()=>{started();await wait;return {totalPages:1,manifest:[{page:1,ocr:true}]};});
  await queue.enqueue(user._id,String(f._id),'library-ocr-test');const work=queue.runOnce();await ready;
  await store.remove(user._id,String(f._id));release();await work;
  assert.equal((await File.findById(f._id)).ocrCache,null);assert.equal((await File.findById(f._id)).ocrProgress,null);assert.equal((await Quota.findById(user._id)).bytes,0);assert.equal((await Job.findOne({file:f._id})).status,'cancelled');
  await assert.rejects(queue.enqueue(user._id,String(f._id),'library-ocr-test'),{fileError:'FILE_NOT_FOUND'});
});
integration('generated replay returns tombstone; quota limits do not evict existing library files',async()=>{
  const f=await create({source:'generated',resultKey:'one-output'});await store.remove(user._id,String(f._id));
  const replay=await create({source:'generated',resultKey:'one-output'});assert.equal(replay.status,'deleted');assert.equal(await Chunk.countDocuments(),0);
  const keep=await create();process.env.FILES_USER_COUNT='1';
  try{await assert.rejects(create(),{fileError:'FILE_QUOTA_EXCEEDED'});assert.equal((await store.read(user._id,String(keep._id))).buffer.length,keep.size);}finally{delete process.env.FILES_USER_COUNT;}
});
