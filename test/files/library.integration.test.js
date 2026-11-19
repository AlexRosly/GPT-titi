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
  const keep=await create();const prev=process.env.FILES_USER_BYTES;process.env.FILES_USER_BYTES=String(keep.size);
  try{await assert.rejects(create(),{fileError:'FILE_QUOTA_EXCEEDED'});assert.equal((await store.read(user._id,String(keep._id))).buffer.length,keep.size);}finally{if(prev===undefined)delete process.env.FILES_USER_BYTES;else process.env.FILES_USER_BYTES=prev;}
});

integration('501st upload and generated files use only bytes, with atomic admission and refunds', async t => {
  const prior = process.env.FILES_USER_COUNT;
  process.env.FILES_USER_COUNT='500'; // Existing deployments need no env edit.
  t.after(()=>{ if(prior===undefined) delete process.env.FILES_USER_COUNT; else process.env.FILES_USER_COUNT=prior; });
  const cap=require('../../src/services/files/config').quotaBytes();
  await Quota.create({_id:user._id, count:500, bytes:cap-2});
  const upload=async()=>{const form=new FormData();form.append('file',new Blob(['x']),'x.txt');
    return fetch(root+'/files',{method:'POST',headers:ownHeaders,body:form});};
  assert.equal((await upload()).status,201);
  const writes=await Promise.allSettled([1,2].map(()=>create({source:'generated',buffer:Buffer.from('y')})));
  assert.equal(writes.filter(w=>w.status==='fulfilled').length,1);
  assert.equal(writes.find(w=>w.status==='rejected').reason.fileError,'FILE_QUOTA_EXCEEDED');
  const full=await upload();assert.equal(full.status,413);assert.equal((await full.json()).error,'FILE_QUOTA_EXCEEDED');
  const quota=await Quota.findById(user._id);assert.equal(quota.count,502);assert.equal(quota.bytes,cap);
  await store.remove(user._id,String(writes.find(w=>w.status==='fulfilled').value._id));
  assert.equal((await upload()).status,201);
  assert.equal((await list()).quota.maxCount,cap); // numeric compatibility for older clients
  const limits=await (await fetch(root+'/files/limits?libraryVersion=2',{headers:ownHeaders})).json();
  assert.equal(limits.storage.maxCount,null);assert.equal(limits.storage.maxBytes,cap);
  assert.equal(limits.message.maxAttachments,10);
});

integration('paged library: whole-owner filters, stable ties, literal search, no missing or duplicate pages', async()=>{
  for (const [name,size,source] of [['same.PDF',4,'upload'],['SAME.pdf',4,'generated'],['note[1].txt',7,'upload'],['small.xlsx',1,'upload']])
    await create({name,buffer:Buffer.alloc(size,1),source});
  await create({user:other._id,name:'same.pdf'});
  await create({name:'same.pdf',source:'generated',retention:'temporary'});
  const read=async(params)=>fetch(root+'/files?'+new URLSearchParams({view:'library',limit:1,...params}),{headers:ownHeaders});
  for (const sort of ['newest','oldest','name','size']) {
    const full=await (await read({sort,limit:40})).json();
    assert.equal(full.listVersion,2);assert.equal(full.quota.maxCount,null);
    assert.equal(full.files.length,4);assert.equal(full.nextCursor,null);
    let cursor,ids=[];
    do {const res=await read({sort,...(cursor?{cursor}:{})});assert.equal(res.status,200);
      const p=await res.json();ids.push(...p.files.map(f=>f.fileId));cursor=p.nextCursor;
      assert.ok(ids.length<=4);
    } while(cursor);
    assert.deepEqual(ids,full.files.map(f=>f.fileId));assert.equal(new Set(ids).size,4);
  }
  let p=await (await read({q:'same',category:'Documents',source:'generated'})).json();
  assert.deepEqual(p.files.map(f=>f.originalName),['SAME.pdf']);
  p=await (await read({q:'[1]',category:'Text & code'})).json();
  assert.deepEqual(p.files.map(f=>f.originalName),['note[1].txt']);
  p=await (await read({q:'.*'})).json();assert.equal(p.files.length,0);
  const first=await (await read({sort:'name'})).json();await store.remove(user._id,first.files[0].fileId);
  const next=await (await read({sort:'name',cursor:first.nextCursor})).json();assert.equal(next.files.length,1);
  for (const opts of [{q:'\0'},{cursor:'x'},{limit:101},{sort:'bad'},{sort:'size',cursor:first.nextCursor}])
    assert.equal((await read(opts)).status,400);
});

// Files-page deduplication is intentionally opt-in; POST /files is the chat path.
async function postUpload(name, bytes, { headers = ownHeaders, library = true } = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  const r = await fetch(root + (library ? '/files/library-upload' : '/files'), { method: 'POST', headers, body: form });
  return { status: r.status, data: await r.json() };
}

integration('two concurrent Files uploads race for the last bytes: one ID, one charge; repeats work at full capacity', async t => {
  const prev = process.env.FILES_USER_BYTES;
  process.env.FILES_USER_BYTES = '5';
  t.after(() => { if (prev === undefined) delete process.env.FILES_USER_BYTES; else process.env.FILES_USER_BYTES = prev; });
  const pair = await Promise.all([postUpload('original.txt', 'hello'), postUpload('renamed.TXT', 'hello')]);
  assert.deepEqual(pair.map(x => x.status).sort(), [200, 201], JSON.stringify(pair));
  const winner = pair.find(x => x.data.outcome === 'added').data.file;
  for (const { data } of pair) {
    assert.equal(data.file.fileId, winner.fileId);
    assert.equal(data.file.originalName, winner.originalName);
  }
  const retry = await postUpload('retry.txt', 'hello');
  assert.equal(retry.status, 200); assert.equal(retry.data.outcome, 'existing');
  const full = await postUpload('original.txt', 'other');
  assert.equal(full.status, 413); assert.equal(full.data.error, 'FILE_QUOTA_EXCEEDED');
  const quota = await Quota.findById(user._id).lean();
  assert.equal(quota.bytes, 5); assert.equal(quota.count, 1);
  assert.equal(await File.countDocuments(), 1); assert.equal(await Chunk.countDocuments(), 1);
  assert.equal((await store.read(user._id, winner.fileId)).buffer.toString(), 'hello');
});

integration('compare server bytes and format, scoped to active uploads of this owner; never resurrect a deleted file', async () => {
  const input = 'abc';
  await create({ name:'original.txt', buffer:Buffer.from(input), source:'generated' });
  await create({ name:'temp.txt', buffer:Buffer.from(input), source:'generated', retention:'temporary' });
  await create({ name:'expired.txt', buffer:Buffer.from(input) }).then(f=>File.updateOne({_id:f._id},{$set:{expiresAt:new Date(1)}}));
  const a = await postUpload('original.txt', input);
  const b = await postUpload('original.txt', 'xyz');
  const c = await postUpload('table.csv', input);
  const foreign = await postUpload('original.txt', input, { headers:otherHeaders });
  for (const result of [a,b,c,foreign]) assert.equal(result.status,201);
  assert.equal(new Set([a,b,c,foreign].map(x=>x.data.file.fileId)).size,4);
  const retry = await postUpload('renamed.TXT', input);
  assert.equal(retry.data.file.fileId, a.data.file.fileId); assert.equal(retry.data.file.originalName,'original.txt');
  const jpeg = Buffer.from([255,216,255,219]);
  const jpg = await postUpload('photo.jpg',jpeg);
  const alias = await postUpload('copy.JPEG',jpeg);
  assert.equal(jpg.status,201); assert.equal(alias.status,200); assert.equal(jpg.data.file.fileId,alias.data.file.fileId);
  await store.remove(user._id,a.data.file.fileId);
  const fresh = await postUpload('restored.txt', input);
  assert.equal(fresh.status,201); assert.notEqual(fresh.data.file.fileId,a.data.file.fileId);
  assert.equal((await File.findById(a.data.file.fileId)).status,'deleted');
});

integration('existing duplicates and direct chat uploads keep their IDs and quota; Files reuses oldest active upload', async () => {
  const a = await postUpload('old.txt','same',{library:false});
  const b = await postUpload('second.txt','same',{library:false});
  assert.equal(a.status,201); assert.equal(b.status,201);
  assert.notEqual(a.data.file.fileId,b.data.file.fileId);
  const reused = await postUpload('third.txt','same');
  assert.equal(reused.status,200); assert.equal(reused.data.file.fileId,a.data.file.fileId);
  const c = await postUpload('old.txt','same',{library:false});
  assert.equal(c.status,201); assert.notEqual(c.data.file.fileId,a.data.file.fileId);
  assert.equal(await File.countDocuments({status:'ready'}),3);
  assert.equal((await Quota.findById(user._id)).bytes,12);
  await store.remove(user._id,a.data.file.fileId);
  const next = await postUpload('fourth.txt','same');
  assert.equal(next.data.file.fileId,b.data.file.fileId);
  for (const f of [b,c]) assert.equal((await store.read(user._id,f.data.file.fileId)).buffer.toString(),'same');
});

integration('delete chat with files removes shared uploads and generated outputs once, preserving other histories and owners', async()=>{
  const removeChat=require('../../src/services/files/deleteConversationFiles');
  const file=await create(); const generated=await create({source:'generated',name:'answer.txt'});
  const foreign=await create({user:other._id}); const unrelated=await create();
  const chat=await ChatConversation.create({user:user._id,title:'Delete me'});
  const kept=await ChatConversation.create({user:user._id,title:'Keep history'});
  await ChatMessage.create({user:user._id,conversation:chat._id,role:'user',content:'Cleared input',deleted:new Date(),attachments:[{fileId:file.id},{fileId:file.id},{fileId:foreign.id}]});
  await ChatMessage.create({user:user._id,conversation:chat._id,role:'assistant',content:'Generated',attachments:[{fileId:generated.id}]});
  const history=await ChatMessage.create({user:user._id,conversation:kept._id,role:'user',content:'Shared file',attachments:[{fileId:file.id}]});
  const quota=await Quota.findById(user._id).lean();
  assert.equal((await removeChat(user.id,chat.id,true)).deletedFiles,2);
  assert.equal((await File.findById(file._id)).status,'deleted');
  assert.equal((await File.findById(generated._id)).status,'deleted');
  assert.equal((await File.findById(foreign._id)).status,'ready');
  assert.equal((await File.findById(unrelated._id)).status,'ready');
  assert.equal((await ChatMessage.findById(history._id)).content,'Shared file');
  assert.equal((await ChatConversation.findById(kept._id)).archived,false);
  assert.equal((await Quota.findById(user._id)).count,quota.count-2);
  assert.equal((await Quota.findById(user._id)).bytes,quota.bytes-file.size-generated.size);
  assert.equal((await removeChat(user.id,chat.id,true)).deletedFiles,0);
  assert.equal((await Quota.findById(user._id)).count,quota.count-2);
});
integration('unchecked deletion and archive preserve files; foreign conversation cannot be deleted', async()=>{
  const removeChat=require('../../src/services/files/deleteConversationFiles');
  const file=await create(); const chat=await ChatConversation.create({user:user._id,title:'Keep files'});
  await ChatMessage.create({user:user._id,conversation:chat._id,role:'user',content:'Input',attachments:[{fileId:file.id}]});
  await assert.rejects(removeChat(other.id,chat.id,true),e=>e.fileError==='CONVERSATION_NOT_FOUND');
  assert.equal((await ChatConversation.findById(chat._id)).archived,false);
  await removeChat(user.id,chat.id,false);
  assert.equal((await File.findById(file._id)).status,'ready');
});
integration('active turn rejects deletion atomically; completed turn-only attachment is deleted', async()=>{
  const Turn=require('../../src/models/chatTurn');
  const removeChat=require('../../src/services/files/deleteConversationFiles');
  const file=await create(); const chat=await ChatConversation.create({user:user._id,title:'Busy'});
  const turn=await Turn.create({user:user._id,conversation:chat._id,turnId:'delete-files-busy',clientMessageId:'delete-busy',requestHash:'hash',modelId:'test',message:'Input',userMessage:new mongoose.Types.ObjectId(),status:'processing',files:[{fileId:file.id}]});
  try {
    await assert.rejects(removeChat(user.id,chat.id,true),e=>e.fileError==='CHAT_BUSY_STOP_BEFORE_DELETE');
    assert.equal((await ChatConversation.findById(chat._id)).archived,false);
    assert.equal((await File.findById(file._id)).status,'ready');
    await Turn.updateOne({_id:turn._id},{$set:{status:'completed'}});
    assert.equal((await removeChat(user.id,chat.id,true)).deletedFiles,1);
  } finally {await Turn.deleteOne({_id:turn._id});}
});
integration('a file deletion error rolls back chat archival, file bytes and quota together', async()=>{
  const removeChat=require('../../src/services/files/deleteConversationFiles');
  const file=await create(); const chat=await ChatConversation.create({user:user._id,title:'Rollback'});
  await ChatMessage.create({user:user._id,conversation:chat._id,role:'user',content:'Input',attachments:[{fileId:file.id}]});
  const before=await Quota.findById(user._id).lean(); const original=store.remove;
  store.remove=async(...args)=>{await original(...args);throw Error('injected failure');};
  try {await assert.rejects(removeChat(user.id,chat.id,true),/injected failure/);} finally {store.remove=original;}
  assert.equal((await ChatConversation.findById(chat._id)).archived,false);
  assert.equal((await File.findById(file._id)).status,'ready');
  assert.equal((await Quota.findById(user._id)).bytes,before.bytes);
  assert.equal((await store.read(user.id,file.id)).buffer.toString(),'private bytes');
});

integration('project deletion removes all member chats and deduplicates shared files, preserves outside history', async()=>{
  const {Project}=require('../../src/models');
  const removeProject=require('../../src/services/files/deleteProjectFiles');
  const project=await Project.create({user:user._id,title:'Delete project'});
  const file=await create(); const chats=[];
  for(let i=0;i<2;i++){
    const chat=await ChatConversation.create({user:user._id,title:'Member',project:project._id});chats.push(chat);
    await ChatMessage.create({user:user._id,conversation:chat._id,role:'user',content:'Shared',attachments:[{fileId:file.id}]});
  }
  const outside=await ChatConversation.create({user:user._id,title:'Outside'});
  await ChatMessage.create({user:user._id,conversation:outside._id,role:'user',content:'History',attachments:[{fileId:file.id}]});
  await assert.rejects(removeProject(other.id,project.id,true,true),e=>e.fileError==='PROJECT_NOT_FOUND');
  const result=await removeProject(user.id,project.id,true,true);
  assert.equal(result.deletedChatIds.length,2);assert.equal(result.deletedFiles,1);
  for(const chat of chats){const saved=await ChatConversation.findById(chat._id);assert.equal(saved.archived,true);assert.equal(saved.project,null);}
  assert.equal((await ChatConversation.findById(outside._id)).archived,false);
  assert.equal(await ChatMessage.countDocuments({conversation:outside._id}),1);
  assert.equal((await Quota.findById(user._id)).count,0);
  assert.equal((await removeProject(user.id,project.id,true,true)).deletedFiles,0);
  await Project.deleteOne({_id:project._id});
});
integration('project keep-chats and keep-files choices preserve requested data; invalid combination rejected',async()=>{
  const {Project}=require('../../src/models');const removeProject=require('../../src/services/files/deleteProjectFiles');
  for(const deleteChats of [false,true]){
    const project=await Project.create({user:user._id,title:'Options'});const file=await create();
    const chat=await ChatConversation.create({user:user._id,title:'Member',project:project._id});
    await ChatMessage.create({user:user._id,conversation:chat._id,role:'user',content:'Input',attachments:[{fileId:file.id}]});
    await assert.rejects(removeProject(user.id,project.id,false,true),e=>e.fileError==='INVALID_DELETE_OPTIONS');
    assert.equal((await Project.findById(project._id)).deleted,null);
    await removeProject(user.id,project.id,deleteChats,false);
    assert.equal((await File.findById(file._id)).status,'ready');
    assert.equal((await ChatConversation.findById(chat._id)).archived,deleteChats);
    assert.equal((await ChatConversation.findById(chat._id)).project,null);
    await Project.deleteOne({_id:project._id});
  }
});
integration('busy project member rolls back the entire project cascade',async()=>{
  const {Project,ChatTurn}=require('../../src/models');const removeProject=require('../../src/services/files/deleteProjectFiles');
  const project=await Project.create({user:user._id,title:'Atomic'});const file=await create();
  const a=await ChatConversation.create({user:user._id,title:'A',project:project._id});
  const b=await ChatConversation.create({user:user._id,title:'B',project:project._id});
  await ChatMessage.create({user:user._id,conversation:a._id,role:'user',content:'Input',attachments:[{fileId:file.id}]});
  const turn=await ChatTurn.create({user:user._id,conversation:b._id,turnId:'project-busy',clientMessageId:'project-busy',requestHash:'hash',modelId:'test',message:'Busy',userMessage:new mongoose.Types.ObjectId(),status:'processing'});
  try {
    await assert.rejects(removeProject(user.id,project.id,true,true),e=>e.fileError==='CHAT_BUSY_STOP_BEFORE_DELETE');
    assert.equal((await Project.findById(project._id)).deleted,null);
    assert.equal((await ChatConversation.findById(a._id)).archived,false);
    assert.equal(String((await ChatConversation.findById(a._id)).project),project.id);
    assert.equal((await File.findById(file._id)).status,'ready');
  }finally{await ChatTurn.deleteOne({_id:turn._id});await Project.deleteOne({_id:project._id});}
});
