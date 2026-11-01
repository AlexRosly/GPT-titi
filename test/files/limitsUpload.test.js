const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { spool, receive } = require('../../src/services/files/streamUpload');
const limits = require('../../src/services/files/limits');
const config = require('../../src/services/files/config');
const express = require('express');

test('storage profile uses decimal units and separates upload from unchanged processing', () => {
  process.env.PRIVATE_FILES_ENABLED = 'true';
  const profile = limits.effective({ textInputEnabled: false, officeInputEnabled: false, zipInputEnabled: false, ocrInputEnabled: false });
  assert.equal(profile.version, 1);
  assert.equal(profile.storage.maxBytes, 2_000_000_000);
  assert.equal(profile.upload.types.archive.maxBytes, 50_000_000);
  assert.equal(profile.processing.text.maxBytes, 65536);
  assert.equal(profile.processing.text.enabled, false);
  assert.equal(profile.processing.office.enabled, false);
  assert.equal(profile.processing.zip.enabled, false);
  assert.equal(profile.processing.ocr.enabled, false);
  assert.equal(profile.message.maxBytes, config.maxBytes());
  assert.equal(profile.upload.types.spreadsheet.maxBytes, 20_000_000);
  assert.equal(limits.uploadLimit('Photo.JPEG'), 15_000_000);
  assert.equal(limits.uploadLimit('doc.pdf'), 25_000_000);
  assert.equal(limits.uploadLimit('code.py'), 1_000_000);
  assert.throws(() => limits.uploadLimit('a.exe'), { fileError: 'UNSUPPORTED_FILE_TYPE' });
  process.env.FILES_UPLOAD_MAX_BYTES = '123';
  process.env.FILES_USER_BYTES = '1000';
  try {
    assert.equal(limits.uploadLimit('a.pdf'), 123);
    assert.equal(limits.effective().storage.maxBytes, 1000);
    assert.equal(limits.effective().upload.types.archive.maxBytes, 123);
  } finally { delete process.env.FILES_UPLOAD_MAX_BYTES; delete process.env.FILES_USER_BYTES; }
});
test('stream validates UTF-8 across chunks, persists bytes privately and reads replay from offset zero', async () => {
  const bytes = Buffer.from('Україна\n日本語\n');
  const upload = await spool(Readable.from([...bytes].map(b => Buffer.from([b]))), 'дані.txt');
  try {
    assert.equal(upload.size, bytes.length);
    assert.equal(upload.checksum, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal((await upload.handle.stat()).mode & 0o777, 0o600);
    if (process.platform === 'linux') assert.match(await fs.readlink(`/proc/self/fd/${upload.handle.fd}`), /\(deleted\)$/);
    for (let i = 0; i < 2; i++) {
      const actual = Buffer.alloc(bytes.length);
      await upload.handle.read(actual, 0, bytes.length, 0);
      assert.deepEqual(actual, bytes);
    }
  } finally { await upload.handle.close(); }
});
test('upload boundary, invalid UTF-8 tail, null bytes, fake signatures and cancellation reject', async () => {
  const exact = await spool(Readable.from([Buffer.alloc(1_000_000, 65)]), 'a.txt');
  await exact.handle.close();
  await assert.rejects(spool(Readable.from([Buffer.alloc(1_000_001, 65)]), 'a.txt'), { fileError: 'FILE_TOO_LARGE' });
  await assert.rejects(spool(Readable.from([Buffer.from([0xe2])]), 'a.txt'), { fileError: 'INVALID_UTF8' });
  await assert.rejects(spool(Readable.from([Buffer.from([65, 0])]), 'a.txt'), { fileError: 'INVALID_TEXT' });
  await assert.rejects(spool(Readable.from([Buffer.from('not png')]), 'a.png'), { fileError: 'UNSUPPORTED_FILE_TYPE' });
  await assert.rejects(spool(Readable.from([]), 'a.txt'), { fileError: 'EMPTY_FILE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(spool(Readable.from([Buffer.from('abc')]), 'a.txt', controller.signal), { name: 'AbortError' });
});
test('HTTP multipart cleans descriptor on success, persistence failure and extra fields', async () => {
  const app = express();
  let captured;
  app.post('/', receive(async (req, res) => {
    captured = req.file.handle;
    if (req.file.name === 'fail.txt') throw new Error('test failure');
    res.json({ size: req.file.size, mimetype: req.file.mimetype, buffer: Boolean(req.file.buffer) });
  }));
  app.use((e, req, res, next) => res.status(500).json({ error: e.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const post = async (name, extra = false) => {
    const data = new FormData(); data.append('file', new Blob(['hello'], { type: 'image/png' }), name);
    if (extra) data.append('bad', 'field');
    return fetch(url, { method: 'POST', body: data });
  };
  try {
    const ok = await post('good.txt');
    assert.deepEqual(await ok.json(), { size: 5, mimetype: 'text/plain', buffer: false });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(captured.fd, -1);
    assert.equal((await post('fail.txt')).status, 500);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(captured.fd, -1);
    assert.equal((await post('good.txt', true)).status, 400);
    assert.equal((await post('good.txt')).status, 200); // Slot released after errors.
  } finally { await new Promise(r => server.close(r)); }
});

test('concurrent uploads are bounded until persistence completes; slots recover', async () => {
  const app = express();
  let finish, entered;
  const started = new Promise(r => { entered = r; });
  const held = new Promise(r => { finish = r; });
  process.env.FILES_UPLOAD_SLOTS = '1';
  app.post('/', receive(async (req, res) => { entered(); await held; res.json({ ok: true }); }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const post = () => {
    const body = new FormData(); body.append('file', new Blob(['hi']), 'x.txt');
    return fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body });
  };
  try {
    const first = post(); await started;
    const second = await post(); assert.equal(second.status, 503);
    assert.deepEqual(await second.json(), { error: 'FILE_UPLOAD_BUSY', retryable: true });
    finish(); assert.equal((await first).status, 200);
    await new Promise(r => setTimeout(r, 20));
    assert.equal((await post()).status, 200);
  } finally { finish(); delete process.env.FILES_UPLOAD_SLOTS; await new Promise(r => server.close(r)); }
});

test('disconnected multipart upload releases its slot and private descriptor', { timeout: 5000 }, async () => {
  const http = require('node:http');
  const app = express(); let admitted;
  const ready = new Promise(r => { admitted = r; });
  process.env.FILES_UPLOAD_SLOTS = '1';
  app.use((req, res, next) => { req.once('data', admitted); next(); });
  app.post('/', receive(async (req, res) => res.json({ ok: true })));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const request = http.request(url, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=boundary32' } });
  request.on('error', () => {});
  try {
    request.write('--boundary32\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\npartial');
    await ready; await new Promise(r => setTimeout(r, 20)); request.destroy();
    let status;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 20));
      const body = new FormData(); body.append('file', new Blob(['ok']), 'x.txt');
      status = (await fetch(url, { method: 'POST', body })).status;
      if (status !== 503) break;
    }
    assert.equal(status, 200);
  } finally { request.destroy(); delete process.env.FILES_UPLOAD_SLOTS; await new Promise(r => server.close(r)); }
});

test('50 MB storage upload is streamed; archive reading remains separately bounded', async () => {
  async function* archive(bytes) {
    yield Buffer.from('504b0304', 'hex');
    let remaining = bytes - 4;
    const chunk = Buffer.alloc(256 * 1024);
    while (remaining > 0) { const n = Math.min(remaining, chunk.length); yield chunk.subarray(0, n); remaining -= n; }
  }
  const upload = await spool(Readable.from(archive(50_000_000)), 'large.zip');
  try { assert.equal(upload.size, 50_000_000); assert.equal((await upload.handle.stat()).size, 50_000_000); }
  finally { await upload.handle.close(); }
  await assert.rejects(spool(Readable.from(archive(50_000_001)), 'large.zip'), { fileError: 'FILE_TOO_LARGE' });
  assert.equal(limits.effective().processing.zip.inputBytes, 10 * 1024 ** 2);
});
