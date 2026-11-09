const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../../src/services/files/libraryMigration');
const limits = require('../../src/services/files/limits');
test('retention classification never revives tombstones or expired files; staged exports stay temporary', () => {
  const base = { status: 'ready', source: 'upload', expiresAt: null };
  assert.equal(classify(base), 'library');
  assert.equal(classify({ ...base, expiresAt: new Date(Date.now()+86400000) }), 'library');
  assert.equal(classify({ ...base, source: 'generated', expiresAt: new Date(Date.now()+86400000) }), 'temporary');
  assert.equal(classify({ ...base, retention: 'temporary' }), 'temporary');
  assert.equal(classify({ ...base, expiresAt: new Date(0) }), 'expired');
  assert.equal(classify({ ...base, status: 'deleted' }), 'deleted');
  assert.equal(limits.effective().storage.retention, 'until_user_deletes');
  assert.equal(limits.effective().storage.unattachedTtlSeconds, null);
});
test('normal uploads and generated outputs persist; only internal staged exports get an expiry', async t => {
  const File = require('../../src/models/managedFile');
  const Chunk = require('../../src/models/fileChunk');
  const Quota = require('../../src/models/fileQuota');
  const store = require('../../src/services/files/store');
  const writes=[];
  t.mock.method(Quota,'updateOne',async()=>({modifiedCount:1}));
  t.mock.method(File,'create',async docs=>{writes.push(docs[0]);return [{...docs[0],_id:'abc'}];});
  t.mock.method(Chunk,'insertMany',async()=>{});
  const base={user:'owner',name:'a.txt',mimetype:'text/plain',buffer:Buffer.from('text'),session:{}};
  await store.create(base);await store.create({...base,source:'generated'});await store.create({...base,source:'generated',retention:'temporary'});
  assert.deepEqual(writes.map(f=>f.retention),['library','library','temporary']);
  assert.equal(writes[0].expiresAt,null);assert.equal(writes[1].expiresAt,null);assert.ok(writes[2].expiresAt>Date.now());
  await assert.rejects(store.create({...base,retention:'temporary'}),{fileError:'INVALID_FILE_RETENTION'});
});
test('chat cleanup cannot delete library files, and duplicate selection fails before a second read', async t => {
  const store=require('../../src/services/files/store');
  const File=require('../../src/models/managedFile');
  const messages=require('../../src/services/files/messages');
  const reader=require('../../src/services/files/inputReader');
  const remove=t.mock.method(store,'remove',async()=>{throw Error('Must not delete');});
  await messages.removeUnreferenced('owner',['0123456789abcdef01234567'],{});assert.equal(remove.mock.callCount(),0);
  t.mock.method(File,'updateOne',async()=>({matchedCount:1}));
  t.mock.method(reader,'supported',()=>false);
  const owned=t.mock.method(store,'owned',async()=>({_id:'0123456789abcdef01234567',mimetype:'image/png',size:1,status:'ready'}));
  await assert.rejects(messages.resolve('owner',[{fileId:'0123456789abcdef01234567'},{fileId:'0123456789ABCDEF01234567'}],{}),{fileError:'INVALID_ATTACHMENTS'});
  assert.equal(owned.mock.callCount(),1);
});
test('staged cleanup refuses to remove a published result', async t => {
  const store=require('../../src/services/files/store');const File=require('../../src/models/managedFile');
  t.mock.method(File,'findOne',()=>({session:async()=>({_id:'0123456789abcdef01234567',source:'generated',status:'ready',retention:'library',expiresAt:null})}));
  const write=t.mock.method(File,'updateOne',async()=>{throw Error('Must not delete');});
  await store.removeTemporary('owner','0123456789abcdef01234567',{});assert.equal(write.mock.callCount(),0);
});
