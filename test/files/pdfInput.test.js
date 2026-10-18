process.env.OCR_ENABLED = 'false'; // Compatibility path; OCR is covered separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const pdf = require('../../src/services/files/pdfInput');
const text = require('../../src/services/files/textInput');
const store = require('../../src/services/files/store');
const messages = require('../../src/services/files/messages');
const context = require('../../src/services/files/textContext');
const { makePdf } = require('./fixtures/pdfInput');
let input;
test.before(async () => { input = await makePdf(); });
const enabled = t => {
  const old = [process.env.PRIVATE_FILES_ENABLED, process.env.PDF_INPUT_ENABLED];
  process.env.PRIVATE_FILES_ENABLED = 'true'; delete process.env.PDF_INPUT_ENABLED;
  t.after(() => ['PRIVATE_FILES_ENABLED', 'PDF_INPUT_ENABLED'].forEach((key, i) => old[i] === undefined ? delete process.env[key] : process.env[key] = old[i]));
};
test('PDF extracts Unicode text with physical page numbers in order', async () => {
  const value = await pdf.extract(input);
  assert.match(value, /Україна.*42/); assert.match(value, /731/);
  assert.ok(value.indexOf('[PDF PAGE 1 OF 2]') < value.indexOf('Україна'));
  assert.ok(value.indexOf('[PDF PAGE 2 OF 2]') < value.indexOf('731'));
});
test('PDF with no text returns OCR_REQUIRED; mixed pages disclose missing content', async () => {
  await assert.rejects(pdf.extract(await makePdf(['', ''])), { fileError: 'PDF_OCR_REQUIRED' });
  const value = await pdf.extract(await makePdf(['Hello', '', 'Last page']));
  assert.match(value, /PDF PAGE 2 OF 3.*\n.*NO EXTRACTABLE TEXT/s);
  assert.match(value, /OCR is required/); assert.match(value, /Last page/);
});
test('PDF refuses password protection including empty-user-password encryption', async () => {
  for (const options of [{ userPassword: 'secret' }, { ownerPassword: 'owner-secret' }]) {
    await assert.rejects(pdf.extract(await makePdf(['Secret'], options)), { fileError: 'PDF_PASSWORD_PROTECTED' });
  }
});
test('PDF limits file bytes, page count and extracted text without truncation', async () => {
  await assert.rejects(pdf.extract(Buffer.alloc(pdf.FILE_BYTES + 1)), { fileError: 'PDF_ATTACHMENT_TOO_LARGE' });
  await assert.rejects(pdf.extract(await makePdf(Array(51).fill('x'))), { fileError: 'PDF_PAGE_LIMIT' });
  await assert.rejects(pdf.extract(await makePdf(Array(30).fill('long text '.repeat(300)))), { fileError: 'PDF_EXTRACTED_TEXT_TOO_LARGE' });
});
test('PDF validates signature and server MIME and rejects corrupt containers', async () => {
  assert.equal(pdf.supported({ originalName: 'x.PDF', mimetype: 'application/pdf' }), true);
  assert.equal(pdf.supported({ originalName: 'x.pdf', mimetype: 'text/plain' }), false);
  assert.equal(pdf.supported({ originalName: 'x.txt', mimetype: 'application/pdf' }), false);
  for (const bytes of [Buffer.from('not a pdf'), Buffer.from('%PDF-1.7\ncorrupted')]) await assert.rejects(pdf.extract(bytes), { fileError: 'INVALID_PDF_DOCUMENT' });
});
test('PDF defaults on and opt-out is independent and checked before storage reads', async t => {
  enabled(t);
  assert.equal(pdf.enabled({}), true);
  assert.equal(pdf.enabled({ textInputEnabled: false, officeInputEnabled: false, fileOutputEnabled: false }), true);
  t.mock.method(store, 'read', () => { throw new Error('must not read'); });
  await assert.rejects(pdf.readPart('owner', {}, { model: { pdfInputEnabled: false } }), { fileError: 'PDF_INPUT_DISABLED' });
  process.env.PDF_INPUT_ENABLED = 'false'; assert.equal(pdf.enabled({}), false);
});
test('PDF provider and reservation read canonical private content, sharing the text budget', async t => {
  enabled(t);
  const file = { _id: '0123456789abcdef01234567', originalName: 'report.pdf', mimetype: 'application/pdf', size: input.length };
  t.mock.method(store, 'owned', async () => file);
  t.mock.method(store, 'read', async () => ({ file, buffer: input }));
  const attachment = { storage: 'private', fileId: String(file._id), originalName: 'forged', url: 'https://evil.test' };
  const state = text.budget();
  const parts = await messages.providerContent('owner', 'Read', [attachment], { state });
  assert.match(parts[1].text, /report.pdf/); assert.match(parts[1].text, /Україна/);
  assert.doesNotMatch(parts[1].text, /forged|evil.test/);
  const estimate = await context.estimate('owner', [{ role: 'user', attachments: [attachment, attachment] }, { role: 'assistant', attachments: [attachment] }], {}, null);
  assert.equal(estimate.promptBytes, 2 * state.promptBytes);
  await assert.rejects(pdf.readPart('owner', file, { state: { bytes: text.CONTEXT_BYTES, promptBytes: 0 } }), { fileError: 'TEXT_ATTACHMENTS_CONTEXT_TOO_LARGE' });
});
test('PDF parser concurrency is bounded and slots are released', async () => {
  const first = pdf.extract(input), second = pdf.extract(input);
  await assert.rejects(pdf.extract(input), { fileError: 'PDF_PROCESSING_BUSY' });
  await Promise.all([first, second]);
  assert.match(await pdf.extract(input), /731/);
});

test('PDF extraction ignores embedded JavaScript and external action targets', async () => {
  const bytes = await makePdf(['Visible text only'], {}, doc => {
    const action = doc.ref({ S: 'JavaScript', JS: new String('throw new Error("script must not execute")') });
    action.end(); doc._root.data.OpenAction = action;
    doc.link(10, 10, 20, 20, 'https://example.invalid/not-fetched');
  });
  const result = await pdf.extract(bytes);
  assert.match(result, /Visible text only/);
  assert.doesNotMatch(result, /script must not execute|example.invalid/);
});
