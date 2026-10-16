const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const { User } = require('../../src/models');
const store = require('../../src/services/files/store');
const uri = process.env.FILES_TEST_MONGO_URI;
let server, root, token, stranger, user;
test.before(async () => {
  if (!uri) return;
  if (!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri)) throw new Error('Isolated test DB required');
  await mongoose.connect(uri.replace('gptiti_files_test_local', 'gptiti_files_test_http'));
  await Promise.all([require('../../src/models/managedFile').init(), require('../../src/models/fileChunk').init(), require('../../src/models/fileQuota').init()]);
  process.env.PRIVATE_FILES_ENABLED = 'true'; process.env.JWT_SECRET = 'test-only-secret';
  user = await User.create({ email: 'file-http@example.test', name: 'File owner', status: 'active' });
  const other = await User.create({ email: 'file-other@example.test', name: 'Other', status: 'active' });
  token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
  stranger = jwt.sign({ userId: other.id }, process.env.JWT_SECRET);
  const app = express(); app.use('/files', require('../../src/routes/files'));
  app.use((e,req,res,next) => res.status(500).json({ error: e.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  root = `http://127.0.0.1:${server.address().port}/files`;
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); if (uri) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
test('authenticated upload, download, isolated preview, owner checks and delete', { skip: !uri }, async () => {
  assert.equal((await fetch(root)).status, 401);
  const form = new FormData(); form.append('file', new Blob(['<script>alert(1)</script>']), 'code.html');
  const uploaded = await fetch(root, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  assert.equal(uploaded.status, 201);
  const { file } = await uploaded.json();
  const own = { authorization: `Bearer ${token}` }, other = { authorization: `Bearer ${stranger}` };
  assert.equal((await fetch(`${root}/${file.id}/download`, { headers: other })).status, 404);
  const download = await fetch(`${root}/${file.id}/download`, { headers: own });
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.match(download.headers.get('content-type'), /octet-stream/);
  const preview = await fetch(`${root}/${file.id}/preview`, { headers: own });
  assert.match(preview.headers.get('content-type'), /application\/json/);
  assert.equal((await preview.json()).text, '<script>alert(1)</script>');
  const list = await (await fetch(root, { headers: own })).json(); assert.equal(list.quota.count, 1);
  assert.equal((await fetch(`${root}/${file.id}`, { method: 'DELETE', headers: own })).status, 204);
  assert.equal((await fetch(`${root}/${file.id}/download`, { headers: own })).status, 404);
});
test('SVG preview is static image with restrictive headers', { skip: !uri }, async () => {
  const rendered = require('../../src/services/files/artifacts').render({ filename: 'x.svg' }, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  const file = await store.create({ ...rendered, user: user._id, source: 'generated' });
  const response = await fetch(`${root}/${file.id}/preview`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
});
test('generated PDF/DOCX/XLSX have private structured previews and full downloads', { skip: !uri }, async () => {
  const own = { authorization: `Bearer ${token}` }, other = { authorization: `Bearer ${stranger}` };
  for (const ext of ['pdf', 'docx', 'xlsx']) {
    const content = ext === 'xlsx' ? { sheets: [{ name: 'Дані', rows: [['Товар', 'Кількість'], ['Яблука', 3]] }] } : { title: 'Звіт', blocks: [{ type: 'paragraph', text: 'Український документ' }] };
    const rendered = await require('../../src/services/files/artifacts').renderOutput({ filename: `report.${ext}` }, JSON.stringify(content));
    const file = await store.create({ ...rendered, user: user._id, source: 'generated' });
    const preview = await fetch(`${root}/${file.id}/preview`, { headers: own });
    assert.equal(preview.status, 200); assert.match(preview.headers.get('content-type'), /application\/json/);
    const data = await preview.json(); assert.equal(data.kind, ext === 'xlsx' ? 'workbook' : 'document');
    assert.equal((await fetch(`${root}/${file.id}/preview`, { headers: other })).status, 404);
    const downloaded = await fetch(`${root}/${file.id}/download`, { headers: own });
    assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), rendered.buffer);
    await store.remove(user._id, file.id);
    assert.equal((await require('../../src/models/managedFile').findById(file.id)).generatedPreview, null);
    assert.equal((await fetch(`${root}/${file.id}/preview`, { headers: own })).status, 404);
  }
});
