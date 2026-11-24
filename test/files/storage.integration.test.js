process.env.OCR_ENABLED = 'false'; // Compatibility path; OCR is covered separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const store = require('../../src/services/files/store');
const File = require('../../src/models/managedFile');
const Chunk = require('../../src/models/fileChunk');
const Quota = require('../../src/models/fileQuota');
const { validateUpload } = require('../../src/services/files/validation');
const uri = process.env.FILES_TEST_MONGO_URI;
let user;
test.before(async () => {
  if (!uri) return;
  // Explicit isolated URI only. Never fall back to production MONGO_URI.
  if (!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri)) throw new Error('Dedicated gptiti_files_test_* database required');
  await mongoose.connect(uri);
  await Promise.all([File.init(), Chunk.init(), Quota.init()]);
  user = new mongoose.Types.ObjectId();
});
test.after(async () => { if (uri) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
const integration = (name, fn) => test(name, { skip: !uri }, fn);
integration('private storage survives reread; owner isolation; idempotent deletion releases quota', async () => {
  const bytes = Buffer.alloc(600000, 65);
  const f = await store.create({ user, name: 'test.txt', mimetype: 'text/plain', buffer: bytes });
  assert.deepEqual((await store.read(user, String(f._id))).buffer, bytes);
  await assert.rejects(store.read(new mongoose.Types.ObjectId(), String(f._id)), { fileError: 'FILE_NOT_FOUND' });
  await store.remove(user, String(f._id)); await store.remove(user, String(f._id));
  assert.equal(await Chunk.countDocuments({ file: f._id }), 0);
  assert.equal((await Quota.findById(user)).bytes, 0);
  await assert.rejects(store.read(user, String(f._id)), { fileError: 'FILE_NOT_FOUND' });
});
integration('concurrent quota claims cannot overspend and rollback does not leave chunks', async () => {
  process.env.FILES_USER_BYTES = '10';
  try {
    const results = await Promise.allSettled([1, 2].map(() => store.create({ user, name: 'q.txt', mimetype: 'text/plain', buffer: Buffer.alloc(8) })));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await Quota.findById(user)).bytes, 8);
    const f = results.find(x => x.status === 'fulfilled').value;
    await store.remove(user, String(f._id));
  } finally { delete process.env.FILES_USER_BYTES; }
});
integration('transaction rollback leaves no file or quota; replay returns same file', async () => {
  await assert.rejects(store.transaction(async session => {
    await store.create({ user, name: 'x.txt', mimetype: 'text/plain', buffer: Buffer.from('hello'), session });
    throw new Error('rollback');
  }));
  assert.equal((await Quota.findById(user)).bytes, 0);
  const args = { user, name: 'x.txt', mimetype: 'text/plain', buffer: Buffer.from('hello'), resultKey: 'turn:1:0' };
  const first = await store.create(args), second = await store.create(args);
  assert.equal(String(first._id), String(second._id));
  await store.remove(user, String(first._id));
});
integration('expiry deletes temporary computation bytes and refunds quota', async () => {
  const f = await store.create({ user, name: 'exp.txt', mimetype: 'text/plain', buffer: Buffer.from('expired'), source: 'generated', retention: 'temporary' });
  await File.updateOne({ _id: f._id }, { expiresAt: new Date(0) });
  await store.cleanup();
  assert.equal((await File.findById(f._id)).status, 'deleted');
  assert.equal((await Quota.findById(user)).bytes, 0);
});
test('upload validation ignores supplied MIME and rejects invalid names and types', () => {
  assert.equal(validateUpload({ originalname: 'x.txt', mimetype: 'image/png', buffer: Buffer.from('text') }).mimetype, 'text/plain');
  for (const originalname of ['../x.txt', 'x\r.txt', 'x.exe', 'x.png']) {
    assert.throws(() => validateUpload({ originalname, buffer: Buffer.from('text') }));
  }
});
integration('message references canonical metadata, retain upload and block documents until processing exists', async () => {
  const messages = require('../../src/services/files/messages');
  const f = await store.create({ user, name: 'image.png', mimetype: 'image/png', buffer: Buffer.from('image bytes') });
  const result = await store.transaction(s => messages.resolve(user, [{ fileId: String(f._id), url: 'https://attacker.example', size: 0 }], s));
  assert.match(result[0].url, /^\/gpt-titi\/api\/files\//);
  assert.equal((await File.findById(f._id)).expiresAt, null);
  const content = await messages.providerContent(user, 'hello', result);
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  await store.remove(user, String(f._id));
  const hydrated = await messages.hydrate(user, [{ attachments: result }]);
  assert.equal(hydrated[0].attachments[0].status, 'deleted');
  assert.equal(hydrated[0].attachments[0].downloadUrl, null);
  const doc = await store.create({ user, name: 'file.pptx', mimetype: 'application/octet-stream', buffer: Buffer.from('doc') });
  await assert.rejects(store.transaction(s => messages.resolve(user, [{ fileId: String(doc._id) }], s)), { fileError: 'DOCUMENT_PROCESSING_NOT_ENABLED' });
  await store.remove(user, String(doc._id));
});

integration('streamed uploads persist multiple chunks; failed checksum/abort roll back quota and chunks', async () => {
  const { spool } = require('../../src/services/files/streamUpload');
  const { Readable } = require('node:stream');
  const bytes = Buffer.alloc(700000, 65);
  const upload = await spool(Readable.from([bytes]), 'stream.txt');
  try {
    const before = await Quota.findById(user).lean();
    const chunkCount = await Chunk.countDocuments();
    await assert.rejects(store.createUpload({ user, upload: { ...upload, checksum: '0'.repeat(64) } }), { fileError: 'FILE_UNAVAILABLE' });
    assert.equal(await Chunk.countDocuments(), chunkCount);
    assert.equal((await Quota.findById(user)).bytes, before.bytes);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(store.createUpload({ user, upload, signal: abort.signal }), { name: 'AbortError' });
    const f = await store.createUpload({ user, upload });
    assert.deepEqual((await store.read(user, String(f._id))).buffer, bytes);
    assert.equal(await Chunk.countDocuments({ file: f._id }), 3);
    await store.remove(user, String(f._id)); await store.remove(user, String(f._id));
    assert.equal((await Quota.findById(user)).bytes, before.bytes);
    // A new transaction reads the same descriptor from offset zero.
    const second = await store.createUpload({ user, upload });
    assert.deepEqual((await store.read(user, String(second._id))).buffer, bytes);
    await store.remove(user, String(second._id));
    process.env.FILES_USER_BYTES = String(before.bytes + bytes.length - 1);
    try { await assert.rejects(store.createUpload({ user, upload }), { fileError: 'FILE_QUOTA_EXCEEDED' }); }
    finally { delete process.env.FILES_USER_BYTES; }
    assert.equal(await Chunk.countDocuments(), chunkCount);
  } finally { await upload.handle.close(); }
});

integration('large uploads publish once, keep independent chat IDs and remove unpublished chunks', async () => {
  const Stage = require('../../src/models/fileUploadStage');
  const {spool} = require('../../src/services/files/streamUpload');
  const {Readable} = require('node:stream');
  const bytes = Buffer.alloc(9 * 1024 ** 2);
  bytes.write('%PDF-1.7');
  const upload = await spool(Readable.from([bytes]), 'large.pdf');
  const owner = new mongoose.Types.ObjectId();
  const before = await Chunk.countDocuments();
  try {
    // Wrong checksum is detected after multiple batches have been written.
    await assert.rejects(store.createUpload({user:owner, upload:{...upload, checksum:'0'.repeat(64)}}),
      {fileError:'FILE_UNAVAILABLE'});
    assert.equal(await File.countDocuments({user:owner}), 0);
    assert.equal(await Chunk.countDocuments(), before);
    assert.equal(await Stage.countDocuments(), 0);
    assert.equal((await Quota.findById(owner)).bytes, 0);
    const args = {user:owner, upload};
    const pair = await Promise.all([store.uploadToLibrary(args), store.uploadToLibrary(args)]);
    assert.deepEqual(pair.map(x => x.outcome).sort(), ['added', 'existing']);
    assert.equal(String(pair[0].file._id), String(pair[1].file._id));
    const chatFile = await store.createUpload(args);
    assert.notEqual(String(chatFile._id), String(pair[0].file._id));
    assert.deepEqual((await store.read(owner, chatFile.id)).buffer, bytes);
    assert.equal((await Quota.findById(owner)).bytes, bytes.length * 2);
    process.env.FILES_USER_BYTES = String(bytes.length * 2);
    try {
      assert.equal((await store.uploadToLibrary(args)).outcome, 'existing');
      await assert.rejects(store.createUpload({user:owner, upload:{...upload, handle:null}}),
        {fileError:'FILE_QUOTA_EXCEEDED'});
    } finally {
      delete process.env.FILES_USER_BYTES;
    }
    assert.equal(await Stage.countDocuments(), 0);
    await store.remove(owner, chatFile.id);
    await store.remove(owner, String(pair[0].file._id));
    assert.equal(await Chunk.countDocuments(), before);
  } finally {
    await upload.handle.close();
  }
});

integration('cleanup after interruption only removes expired upload stages', async () => {
  const Stage = require('../../src/models/fileUploadStage');
  const expired = await Stage.create({expiresAt:new Date(0)});
  const active = await Stage.create({expiresAt:new Date(Date.now() + 60000)});
  for (const stage of [expired, active]) {
    await Chunk.create({file:stage._id, index:0, data:Buffer.from('partial upload')});
    await assert.rejects(store.owned(user, String(stage._id)), {fileError:'FILE_NOT_FOUND'});
  }
  await store.cleanup();
  assert.equal(await Chunk.countDocuments({file:expired._id}), 0);
  assert.equal(await Stage.exists({_id:expired._id}), null);
  assert.equal(await Chunk.countDocuments({file:active._id}), 1);
  assert.ok(await Stage.exists({_id:active._id}));
});
