const test = require('node:test');
const assert = require('node:assert/strict');
const ocr = require('../../src/services/files/ocrInput');
const processOcr = require('../../src/services/files/ocrProcess');
const size = require('../../src/services/files/ocrImageSize');
const store = require('../../src/services/files/store');
const messages = require('../../src/services/files/messages');
const context = require('../../src/services/files/textContext');
const text = require('../../src/services/files/textInput');
const { makeImage, makeScan } = require('./fixtures/ocr');
const { errorFor } = require('../../src/services/chatDeliveryV2/protocol');
process.env.PRIVATE_FILES_ENABLED = 'true';
process.env.OCR_ENABLED = 'true';
process.env.OCR_LANGUAGES = 'eng';
const cache = (content = 'Private OCR 731') => ({ _id: '0123456789abcdef01234567', originalName: 'scan.png', mimetype: 'image/png', size: 100,
  checksum: 'hash', ocrCache: { version: 3, qualityRevision: 1, checksum: 'hash', text: content, pages: 1, languages: 'eng' } });
test('failed quality upgrade preserves the previous readable OCR and releases the pending job', async t => {
  const file = cache('old text 15.40.2026'); delete file.ocrCache.qualityRevision;
  const original = JSON.stringify(file);
  t.mock.method(store, 'owned', async () => file);
  t.mock.method(store, 'read', async () => ({ file, buffer: makeImage() }));
  t.mock.method(store, 'transaction', async () => { throw new Error('must not write failed OCR'); });
  const extract = t.mock.method(processOcr, 'extract', async () => { throw Object.assign(new Error(), { fileError: 'OCR_FAILED' }); });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(ocr.prepare('owner', String(file._id), {}), { fileError: 'OCR_FAILED' });
  assert.equal(extract.mock.callCount(), 2);
  assert.equal(JSON.stringify(file), original);
  assert.match((await ocr.readPart('owner', file, { model: {} })).text, /old text 15\.40\.2026/);
});
test('real OCR reads PNG, JPEG and WEBP without losing the existing visual input', async () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    const result = await processOcr.extract(makeImage(undefined, type), 'image');
    assert.match(result.text, /INVOICE 731 TOTAL 4200/);
    assert.match(result.text, /IMAGE PAGE 1 OF 1/); assert.equal(result.pages, 1);
  }
});
test('real PDF OCR marks scanned, text and blank pages in physical order', async () => {
  const result = await processOcr.extract(await makeScan(['INVOICE 731 TOTAL 4200', { text: 'Text layer 999' }, '']), 'pdf');
  assert.match(result.text, /PDF PAGE 1 OF 3 — OCR.*731/s);
  assert.match(result.text, /PDF PAGE 2 OF 3 — TEXT LAYER.*999/s);
  assert.match(result.text, /PDF PAGE 3 OF 3 — OCR.*NO TEXT RECOGNIZED/s);
  assert.equal(result.pages, 2);
});
test('blank PDFs fail explicitly, visual-only images remain usable', async () => {
  await assert.rejects(processOcr.extract(await makeScan(['']), 'pdf'), { fileError: 'OCR_NO_TEXT' });
  assert.match((await processOcr.extract(makeImage(''), 'image')).text, /NO TEXT RECOGNIZED/);
});
test('OCR rejects protected PDFs, invalid images and oversize bytes', async () => {
  for (const options of [{ userPassword: 'secret' }, { ownerPassword: 'owner-secret' }]) {
    await assert.rejects(processOcr.extract(await makeScan(['Secret'], options), 'pdf'), { fileError: 'PDF_PASSWORD_PROTECTED' });
  }
  await assert.rejects(processOcr.extract(Buffer.from('<svg/>'), 'image'), { fileError: 'OCR_INVALID_IMAGE' });
  await assert.rejects(processOcr.extract(Buffer.alloc(5 * 1024 * 1024 + 1), 'image'), { fileError: 'OCR_FILE_TOO_LARGE' });
  await assert.rejects(processOcr.extract(Buffer.from('%PDF-1.7 broken'), 'pdf'), { fileError: 'INVALID_PDF_DOCUMENT' });
});
test('dimensions are checked before native image decoding', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) assert.deepEqual(size(makeImage('Text', type)), { width: 1400, height: 300 });
  const bomb = makeImage(); bomb.writeUInt32BE(10001, 16);
  assert.throws(() => size(bomb), { fileError: 'OCR_IMAGE_LIMIT' });
  assert.throws(() => size(Buffer.alloc(0)), { fileError: 'OCR_INVALID_IMAGE' });
});
test('missing language packages fail explicitly; text-layer PDF does not need OCR binaries', async t => {
  process.env.OCR_LANGUAGES = 'zzzz'; t.after(() => { process.env.OCR_LANGUAGES = 'eng'; });
  await assert.rejects(processOcr.extract(makeImage(), 'image'), { fileError: 'OCR_UNAVAILABLE' });
  const result = await processOcr.extract(await makeScan([{ text: 'Already readable' }]), 'pdf');
  assert.equal(result.pages, 0); assert.match(result.text, /Already readable/);
});
test('OCR defaults on, has independent model opt-out and respects PDF opt-out', () => {
  delete process.env.OCR_ENABLED;
  assert.equal(ocr.enabled({}), true);
  process.env.OCR_ENABLED = 'true'; assert.equal(ocr.enabled({ ocrInputEnabled: false }), false);
  assert.equal(ocr.eligible({ originalName: 'a.pdf', mimetype: 'application/pdf' }, { pdfInputEnabled: false }), false);
  assert.equal(ocr.eligible(cache(), { textInputEnabled: false, fileOutputEnabled: false }), true);
});
test('private cached OCR keeps canonical metadata, image content, history occurrences and token reserve', async t => {
  const file = cache(), buffer = makeImage();
  t.mock.method(store, 'owned', async (owner, id) => { assert.equal(owner, 'owner'); assert.equal(id, String(file._id)); return file; });
  t.mock.method(store, 'read', async () => ({ file, buffer }));
  t.mock.method(processOcr, 'extract', async () => { throw new Error('must reuse saved OCR'); });
  const attachment = { storage: 'private', fileId: String(file._id), originalName: 'fake', url: 'https://evil.invalid' };
  const state = text.budget();
  const parts = await messages.providerContent('owner', 'Read', [attachment], { state, model: {} });
  const textOnly = await messages.providerContent('owner', 'Read', [attachment], { model: { limits: { maxImages: 0 } } });
  assert.equal(textOnly.length, 2); assert.equal(textOnly.some(p => p.type === 'image_url'), false);
  assert.equal(parts.length, 3); assert.match(parts[1].text, /scan.png.*Private OCR 731/s);
  assert.doesNotMatch(parts[1].text, /fake|evil/); assert.equal(parts[2].type, 'image_url');
  const estimated = await context.estimate('owner', [{ role: 'user', attachments: [attachment, attachment] }], {});
  assert.equal(estimated.promptBytes, state.promptBytes * 2);
  assert.ok(text.reserveAmount(estimated.promptBytes, 1, 0.00001) > 0);
  await ocr.prepare('owner', String(file._id), {});
  assert.equal('ocrCache' in store.dto(file), false);
});
test('OCR owner, missing cache and aggregate limits reject before passing text to provider', async t => {
  const file = cache();
  t.mock.method(store, 'owned', async () => { throw Object.assign(new Error(), { fileError: 'FILE_NOT_FOUND' }); });
  await assert.rejects(ocr.readPart('other', file), { fileError: 'FILE_NOT_FOUND' });
  t.mock.method(store, 'owned', async () => ({ ...file, ocrCache: null }));
  await assert.rejects(ocr.readPart('owner', file), { fileError: 'OCR_NOT_READY' });
  t.mock.method(store, 'owned', async () => file);
  await assert.rejects(ocr.readPart('owner', file, { state: { bytes: text.CONTEXT_BYTES, promptBytes: 0 } }), { fileError: 'TEXT_ATTACHMENTS_CONTEXT_TOO_LARGE' });
  await assert.rejects(ocr.readPart('owner', file, { model: { ocrInputEnabled: false } }), { fileError: 'OCR_INPUT_DISABLED' });
});
test('OCR concurrency cap rejects excess work and releases slots', async () => {
  const a = processOcr.extract(makeImage(), 'image'), b = processOcr.extract(makeImage(), 'image');
  await assert.rejects(processOcr.extract(makeImage(), 'image'), { fileError: 'OCR_PROCESSING_BUSY' });
  await Promise.all([a, b]);
  assert.match((await processOcr.extract(makeImage(), 'image')).text, /731/);
});
test('OCR errors expose actionable messages and only busy/not-ready are retryable', () => {
  for (const code of ['OCR_INPUT_DISABLED','OCR_UNAVAILABLE','OCR_FILE_TOO_LARGE','OCR_PAGE_LIMIT','OCR_IMAGE_LIMIT','OCR_TEXT_TOO_LARGE','OCR_NO_TEXT','OCR_INVALID_IMAGE','OCR_FAILED','OCR_PROCESSING_TIMEOUT','OCR_PROCESSING_BUSY','OCR_NOT_READY']) {
    const error = errorFor(code); assert.equal(error.code, code); assert.ok(error.message.length > 20);
    assert.equal(error.retryable, ['OCR_PROCESSING_BUSY', 'OCR_NOT_READY'].includes(code));
  }
});

test('OCR PDF page and text limits reject the complete document without partial output', async () => {
  await assert.rejects(processOcr.extract(await makeScan(Array(11).fill('')), 'pdf'), { fileError: 'OCR_PAGE_LIMIT' });
  const { makePdf } = require('./fixtures/pdfInput');
  await assert.rejects(processOcr.extract(await makePdf(Array(30).fill('Long text '.repeat(300))), 'pdf'), { fileError: 'OCR_TEXT_TOO_LARGE' });
});
test('concurrent preparation saves one bounded private cache and one quota claim', async t => {
  const file = { ...cache(), ocrCache: null, derivedBytes: 0 };
  const File = require('../../src/models/managedFile'), Quota = require('../../src/models/fileQuota');
  let extracts = 0, claims = 0, writes = 0;
  t.mock.method(store, 'owned', async () => file);
  t.mock.method(store, 'read', async () => ({ file, buffer: makeImage() }));
  t.mock.method(store, 'transaction', async fn => fn('session'));
  t.mock.method(processOcr, 'extract', async () => { extracts++; return { text: 'Saved OCR 731', pages: 1, languages: 'eng' }; });
  t.mock.method(Quota, 'updateOne', async (query, update, options) => {
    assert.equal(options.session, 'session'); assert.equal(update.$inc.bytes, Buffer.byteLength('Saved OCR 731')); claims++; return { matchedCount: 1 };
  });
  t.mock.method(File, 'updateOne', async (query, update) => { assert.equal(query.user, 'owner'); Object.assign(file, update.$set); writes++; return { modifiedCount: 1 }; });
  await Promise.all([ocr.prepare('owner', String(file._id), {}), ocr.prepare('owner', String(file._id), {})]);
  await ocr.prepare('owner', String(file._id), {});
  assert.equal(extracts, 1); assert.equal(claims, 1); assert.equal(writes, 1);
  assert.equal(ocr.cached(file), true);
});
test('OCR quota failure never publishes a cache and deletion before save cannot resurrect a file', async t => {
  const file = { ...cache(), ocrCache: null, derivedBytes: 0 };
  const File = require('../../src/models/managedFile'), Quota = require('../../src/models/fileQuota');
  let reads = 0;
  t.mock.method(store, 'owned', async () => file);
  t.mock.method(store, 'read', async () => ({ file, buffer: makeImage() }));
  t.mock.method(store, 'transaction', async fn => fn('session'));
  t.mock.method(processOcr, 'extract', async () => ({ text: 'Saved OCR 731', pages: 1, languages: 'eng' }));
  t.mock.method(Quota, 'updateOne', async () => ({ matchedCount: 0 }));
  t.mock.method(File, 'updateOne', async () => { throw new Error('cache must not be saved'); });
  await assert.rejects(ocr.prepare('owner', String(file._id), {}), { fileError: 'FILE_QUOTA_EXCEEDED' });
  t.mock.method(store, 'owned', async () => { if (++reads > 1) throw Object.assign(new Error(), { fileError: 'FILE_NOT_FOUND' }); return file; });
  await assert.rejects(ocr.prepare('owner', String(file._id), {}), { fileError: 'FILE_NOT_FOUND' });
});

test('preparation deadline prevents unbounded historical OCR work', async t => {
  t.mock.method(store, 'owned', async () => { throw new Error('must not begin more OCR work'); });
  await assert.rejects(ocr.prepareHistory('owner', [{ role: 'user', attachments: [{ storage: 'private', fileId: '0123456789abcdef01234567' }] }], {}, Date.now() - 1), { fileError: 'OCR_NOT_READY' });
});

for (const oldVersion of [2, 3]) test(`v${oldVersion} cache remains readable and upgrades quality once with only the byte delta`, async t => {
  const file = cache('old recognized text'); file.ocrCache.version = oldVersion; delete file.ocrCache.qualityRevision; file.derivedBytes = 200;
  const File = require('../../src/models/managedFile'), Quota = require('../../src/models/fileQuota');
  let runs = 0, claims = 0;
  t.mock.method(store, 'owned', async () => file);
  t.mock.method(store, 'read', async () => ({ file, buffer: makeImage() }));
  t.mock.method(store, 'transaction', async fn => fn('session'));
  const old = await ocr.readPart('owner', file, { model: {} });
  assert.match(old.text, /old recognized text/);
  t.mock.method(processOcr, 'extract', async () => { runs++; return { text: 'new recognized text', pages: 1, languages: 'auto', detections: [] }; });
  t.mock.method(Quota, 'updateOne', async (query, update) => {
    assert.equal(update.$inc.bytes, Buffer.byteLength('new recognized text') - 200); claims++; return { matchedCount: 1 };
  });
  t.mock.method(File, 'updateOne', async (query, update) => { Object.assign(file, update.$set); return { modifiedCount: 1 }; });
  await ocr.prepare('owner', String(file._id), {}); await ocr.prepare('owner', String(file._id), {});
  assert.equal(file.ocrCache.version, 3); assert.equal(file.ocrCache.qualityRevision, 1); assert.equal(runs, 1); assert.equal(claims, 1);
  assert.equal(file.derivedBytes, Buffer.byteLength('new recognized text'));
});
