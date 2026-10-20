const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../../src/services/files/store');
const ocr = require('../../src/services/files/ocrInput');
const router = require('../../src/routes/files');
const handler = router.stack.find(s => s.route?.path === '/:id/ocr').route.stack[0].handle;
test('saved OCR GET preserves bytes, checks ownership first and never prepares OCR', async t => {
  const text = '[PDF PAGE 1 OF 1 — OCR]\n123 501,601\n<script>x</script>\nשלום';
  const file = { originalName: 'scan.pdf', mimetype: 'application/pdf', checksum: 'abc', ocrCache: { version: 3, qualityRevision: 1, checksum: 'abc', text, pages: 1, detections: [{ uncertain: true }] } };
  t.mock.method(store, 'owned', async (user) => { if (user !== 'owner') throw { fileError: 'FILE_NOT_FOUND', status: 404 }; return file; });
  t.mock.method(ocr, 'prepare', async () => { throw Error('must not process'); });
  async function request(user = 'owner', download = false) {
    const res = { code: 200, headers: {}, set(h) { Object.assign(this.headers, h); return this; }, status(s) { this.code = s; return this; }, json(body) { this.body = body; }, send(body) { this.body = body; } };
    await handler({ user: { _id: user }, params: { id: 'id' }, query: download ? { download: '1' } : {} }, res, e => { throw e; }); return res;
  }
  assert.equal((await request('stranger')).code, 404);
  const saved = JSON.stringify(file);
  const response = await request(); assert.equal(response.body.text, text); assert.equal(response.body.uncertain, true);
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
  const download = await request('owner', true); assert.deepEqual(download.body, Buffer.from(text));
  assert.match(download.headers['Content-Disposition'], /^attachment/);
  assert.equal(JSON.stringify(file), saved); assert.equal(ocr.prepare.mock.callCount(), 0);
  assert.equal((await request()).body.legacy, false);
  delete file.ocrCache.qualityRevision; assert.equal((await request()).body.legacy, true);
  file.ocrCache.version = 2; assert.equal((await request()).body.legacy, true);
  file.ocrCache.checksum = 'stale'; assert.equal((await request()).code, 409);
  file.ocrCache = null; assert.equal((await request()).code, 409);
  file.mimetype = 'text/plain'; assert.equal((await request()).code, 415);
});
