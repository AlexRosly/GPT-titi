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
integration('expiry deletes unattached bytes and refunds quota', async () => {
  const f = await store.create({ user, name: 'exp.txt', mimetype: 'text/plain', buffer: Buffer.from('expired') });
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
  const doc = await store.create({ user, name: 'file.pdf', mimetype: 'application/pdf', buffer: Buffer.from('doc') });
  await assert.rejects(store.transaction(s => messages.resolve(user, [{ fileId: String(doc._id) }], s)), { fileError: 'DOCUMENT_PROCESSING_NOT_ENABLED' });
  await store.remove(user, String(doc._id));
});
