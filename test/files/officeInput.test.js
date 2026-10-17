const test = require('node:test');
const assert = require('node:assert/strict');
const office = require('../../src/services/files/officeInput');
const textInput = require('../../src/services/files/textInput');
const store = require('../../src/services/files/store');
const messages = require('../../src/services/files/messages');
const context = require('../../src/services/files/textContext');
const { docx, xlsx, mutate } = require('./fixtures/officeInput');
let word, book;
test.before(async () => { word = await docx(); book = await xlsx(); });
const enabled = t => {
  const old = [process.env.PRIVATE_FILES_ENABLED, process.env.OFFICE_INPUT_ENABLED];
  process.env.PRIVATE_FILES_ENABLED = 'true'; delete process.env.OFFICE_INPUT_ENABLED;
  t.after(() => ['PRIVATE_FILES_ENABLED', 'OFFICE_INPUT_ENABLED'].forEach((key, i) => old[i] === undefined ? delete process.env[key] : process.env[key] = old[i]));
};
test('DOCX reads Cyrillic paragraphs and table cells in source order', async () => {
  const text = await office.extract(word, 'docx');
  assert.ok(text.indexOf('Україна') < text.indexOf('Товар'));
  assert.ok(text.indexOf('Яблука') < text.indexOf('Кінець'));
  assert.match(text, /42/); assert.match(text, /images.*not included/);
});
test('XLSX preserves sheets, cell addresses, values, hidden data and unevaluated formulas', async () => {
  const text = await office.extract(book, 'xlsx');
  assert.match(text, /Дані/); assert.match(text, /Прихований.*hidden/);
  assert.match(text, /"cell":"B2","type":"n","value":"42"/);
  assert.match(text, /yyyy-mm-dd/); assert.match(text, /Date system: 1900/);
  assert.match(text, /SUM\(B2:B3\)/); assert.match(text, /not recalculated/);
  assert.match(text, /"cachedResult":"missing"/); assert.match(text, /IMPORTXML/);
});
test('Office reader checks real container identity, CRC and format, not client MIME', async () => {
  assert.equal(office.supported({ originalName: 'x.DOCX', mimetype: 'application/octet-stream' }), true);
  assert.equal(office.supported({ originalName: 'x.docx', mimetype: 'text/plain' }), false);
  await assert.rejects(office.extract(word, 'xlsx'), { fileError: 'INVALID_OFFICE_DOCUMENT' });
  await assert.rejects(office.extract(Buffer.from('PK fake'), 'docx'), { fileError: 'INVALID_OFFICE_DOCUMENT' });
  const broken = Buffer.from(word); const central = broken.indexOf(Buffer.from('504b0102', 'hex')); broken[central + 16] ^= 1;
  await assert.rejects(office.extract(broken, 'docx'));
});
test('Office rejects DTD, unsafe paths, external data and embedded objects', async () => {
  for (const attack of [
    async z => z.file('word/document.xml', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'),
    async z => z.file('../escape.xml', '<x/>'),
    async z => z.file('word/embeddings/oleObject1.bin', Buffer.from('object')),
    async z => z.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" TargetMode="External" Target="https://example.test"/></Relationships>'),
  ]) await assert.rejects(office.extract(await mutate(word, attack), 'docx'));
});
test('Office limits compressed input, expanded bytes and extracted content without truncation', async () => {
  await assert.rejects(office.extract(Buffer.alloc(office.FILE_BYTES + 1), 'docx'), { fileError: 'OFFICE_ATTACHMENT_TOO_LARGE' });
  await assert.rejects(office.extract(await docx('A'.repeat(65536)), 'docx'), { fileError: 'OFFICE_EXTRACTED_TEXT_TOO_LARGE' });
  const bomb = await mutate(word, z => z.file('word/bomb.xml', '<x>' + 'A'.repeat(9 * 1024 * 1024) + '</x>'));
  await assert.rejects(office.extract(bomb, 'docx'), { fileError: 'OFFICE_DOCUMENT_LIMIT' });
});
test('Office defaults on for old/new models and opt-out precedes reading bytes', async t => {
  enabled(t);
  assert.equal(office.enabled({}), true);
  assert.equal(office.enabled({ textInputEnabled: false, fileOutputEnabled: false }), true);
  t.mock.method(store, 'read', () => { throw new Error('must not read'); });
  await assert.rejects(office.readPart('u', {}, { model: { officeInputEnabled: false } }), { fileError: 'OFFICE_INPUT_DISABLED' });
  process.env.OFFICE_INPUT_ENABLED = 'false'; assert.equal(office.enabled({}), false);
});
test('Office provider/history use canonical private bytes and shared text budget', async t => {
  enabled(t);
  const file = { _id: '0123456789abcdef01234567', originalName: 'приватний.docx', mimetype: 'application/octet-stream', size: word.length };
  t.mock.method(store, 'owned', async () => file);
  t.mock.method(store, 'read', async () => ({ file, buffer: word }));
  const f = { storage: 'private', fileId: String(file._id), originalName: 'forged', url: 'https://evil.test' };
  const state = textInput.budget();
  const output = await messages.providerContent('owner', 'Read', [f], { state });
  assert.match(output[1].text, /приватний.docx/); assert.match(output[1].text, /Україна/);
  assert.doesNotMatch(output[1].text, /forged|evil\.test/);
  const estimate = await context.estimate('owner', [{ role: 'user', attachments: [f, f] }, { role: 'assistant', attachments: [f] }], {}, null);
  assert.equal(estimate.promptBytes, 2 * state.promptBytes);
  const full = { bytes: textInput.CONTEXT_BYTES, promptBytes: 0 };
  await assert.rejects(office.readPart('owner', file, { state: full }), { fileError: 'TEXT_ATTACHMENTS_CONTEXT_TOO_LARGE' });
});
test('Office concurrent parser capacity is bounded and released after completion', async () => {
  const first = office.extract(word, 'docx'), second = office.extract(book, 'xlsx');
  await assert.rejects(office.extract(word, 'docx'), { fileError: 'OFFICE_PROCESSING_BUSY' });
  await Promise.all([first, second]);
  assert.match(await office.extract(word, 'docx'), /Україна/);
});

test('Office rejects forged ZIP sizes, encrypted entries and bad XML', async () => {
  const central = word.indexOf(Buffer.from('504b0102', 'hex'));
  const encrypted = Buffer.from(word); encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  await assert.rejects(office.extract(encrypted, 'docx'), { fileError: 'OFFICE_DOCUMENT_UNSUPPORTED' });
  const forged = Buffer.from(word); forged.writeUInt32LE(0x7fffffff, central + 24);
  await assert.rejects(office.extract(forged, 'docx'), { fileError: 'OFFICE_DOCUMENT_LIMIT' });
  await assert.rejects(office.extract(await mutate(word, z => z.file('word/document.xml', '<broken>')), 'docx'), { fileError: 'INVALID_OFFICE_DOCUMENT' });
});
test('Office handles UTF-16 XML and refuses unsupported workbook sheet types', async () => {
  const utf16 = await mutate(word, async z => {
    const text = (await z.file('word/document.xml').async('string')).replace(/encoding="UTF-8"/i, 'encoding="UTF-16"');
    z.file('word/document.xml', Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]));
  });
  assert.match(await office.extract(utf16, 'docx'), /Україна/);
  const chartsheet = await mutate(book, async z => {
    const name = 'xl/_rels/workbook.xml.rels';
    z.file(name, (await z.file(name).async('string')).replace('/worksheet"', '/chartsheet"'));
  });
  await assert.rejects(office.extract(chartsheet, 'xlsx'), { fileError: 'INVALID_OFFICE_DOCUMENT' });
});
