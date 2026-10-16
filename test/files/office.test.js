const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const office = require('../../src/services/files/office');
const artifacts = require('../../src/services/files/artifacts');
const document = { title: 'Звіт — Україна', blocks: [{ type: 'heading', text: 'Підсумки' }, { type: 'paragraph', text: 'Їжак, ґанок, Європа. Привіт, світе!\nДругий рядок.' }, { type: 'bullet', text: 'Перевірений пункт' }, { type: 'table', rows: [['Товар', 'Кількість'], ['Яблука', '3']] }] };
test('PDF has a real PDF container and embedded Unicode fonts', async () => {
  const file = await artifacts.renderOutput({ filename: 'report.pdf' }, JSON.stringify(document));
  assert.equal(file.mimetype, 'application/pdf');
  assert.equal(file.buffer.subarray(0, 5).toString(), '%PDF-');
  assert.match(file.buffer.toString('latin1'), /\/ToUnicode/);
  assert.match(file.buffer.toString('latin1'), /%%EOF/);
  assert.equal(file.generatedPreview.kind, 'document');
  assert.equal(file.generatedPreview.title, document.title);
});
test('DOCX contains real Word paragraphs and tables with escaped user text', async () => {
  const source = { ...document, blocks: [...document.blocks, { type: 'paragraph', text: '<script> & user text' }] };
  const file = await artifacts.renderOutput({ filename: 'report.docx' }, JSON.stringify(source));
  const zip = await JSZip.loadAsync(file.buffer);
  assert.ok(zip.file('[Content_Types].xml'));
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /Звіт — Україна/); assert.match(xml, /<w:tbl>/); assert.match(xml, /<w:br\s*\/>/);
  assert.match(xml, /&lt;script&gt; &amp; user text/);
  assert.equal(Object.keys(zip.files).some(x => /vbaProject|embeddings|externalLink/.test(x)), false);
});
test('XLSX preserves sheets and numeric types; formula-like strings stay text', async () => {
  const source = { sheets: [{ name: 'Бюджет', rows: [['Товар', 'Сума'], ['Яблука', 12.5], ['=HYPERLINK("https://evil")', -42]] }, { name: 'Другий', rows: [['Ознака'], [true], [null]] }] };
  const file = await artifacts.renderOutput({ filename: 'budget.xlsx' }, JSON.stringify(source));
  const book = new ExcelJS.Workbook(); await book.xlsx.load(file.buffer);
  assert.equal(book.worksheets.length, 2);
  assert.equal(book.getWorksheet('Бюджет').getCell('B2').value, 12.5);
  assert.equal(book.getWorksheet('Бюджет').getCell('B3').value, -42);
  assert.equal(book.getWorksheet('Бюджет').getCell('A3').type, ExcelJS.ValueType.String);
  assert.equal(book.getWorksheet('Бюджет').getCell('A3').formula, undefined);
  assert.equal(file.generatedPreview.kind, 'workbook');
});
test('document schema rejects executable/remote inputs, invalid names and limits', () => {
  for (const bad of [
    { sheets: [{ name: 'A/B', rows: [['x']] }] },
    { sheets: [{ name: 'Sheet', rows: [['x']] }, { name: 'sheet', rows: [['y']] }] },
    { sheets: [{ name: 'A', rows: [[{ formula: 'WEBSERVICE("https://evil")' }]] }] },
    { sheets: [{ name: 'A', rows: [[{ text: 'x', hyperlink: 'https://evil' }]] }] },
    { sheets: [{ name: 'A', rows: [Array(51).fill('x')] }] },
  ]) assert.throws(() => office.validate('xlsx', JSON.stringify(bad)));
  assert.throws(() => office.validate('docx', JSON.stringify({ title: 'x', blocks: [{ type: 'image', url: 'file:///secret' }] })));
  assert.throws(() => office.validate('pdf', JSON.stringify({ title: 'x', blocks: [{ type: 'table', rows: [['a', 'b'], ['c']] }] })));
  assert.throws(() => office.validate('pdf', 'base64-or-raw-pdf'));
});
test('generated previews stay bounded and disclose omitted content', () => {
  const source = { title: 'Long report', blocks: Array.from({ length: 20 }, () => ({ type: 'paragraph', text: 'Ї'.repeat(4000) })) };
  const preview = office.preview('docx', source);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) <= 60000);
  assert.equal(preview.truncated, true);
  const table = office.preview('xlsx', { sheets: [{ name: 'Long', rows: Array.from({ length: 201 }, () => Array(31).fill(1)) }] });
  assert.equal(table.truncated, true); assert.equal(table.sheets[0].rows.length, 200); assert.equal(table.sheets[0].rows[0].length, 30);
});
test('explicit and automatic file tools describe supported Office manifests', () => {
  for (const ext of ['pdf', 'docx', 'xlsx']) {
    assert.equal(artifacts.outputSpec({ filename: `report.${ext}` }).filename, `report.${ext}`);
    assert.match(artifacts.toolOptions({ filename: `report.${ext}` }).tools[0].function.description, /JSON string describing/);
  }
  assert.match(artifacts.autoToolOptions().tools[0].function.description, /pdf, docx, xlsx/);
});
test('oversized PDF table rows fail explicitly instead of clipping content', async () => {
  const source = { title: 'Too tall', blocks: [{ type: 'table', rows: [Array(8).fill('Heading'), Array(8).fill('word '.repeat(390))] }] };
  await assert.rejects(artifacts.renderOutput({ filename: 'large.pdf' }, JSON.stringify(source)), { fileError: 'DOCUMENT_LAYOUT_LIMIT' });
});
