const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const policy = require('../../src/services/files/ocrLanguages');
const identifiers = require('../../src/services/files/ocrIdentifiers');
const { extract } = require('../../src/services/files/ocrProcess');

test('automatic Cyrillic includes Latin; manual selections and other scripts stay supported', () => {
  const available = new Set(['osd', ...policy.SCRIPTS.map(s => 'script/' + s)]);
  assert.deepEqual(policy.select('auto', available, { script: 'Cyrillic', confidence: 10 }).models, ['script/Cyrillic', 'script/Latin']);
  assert.deepEqual(policy.select('eng', new Set(['eng']), {}).models, ['eng']);
  for (const script of policy.SCRIPTS) assert.ok(policy.select('auto', available, { script, confidence: 10 }).models.length <= 4);
});

test('identifier candidates never transliterate source text or change digits', () => {
  const originals = [{ text: 'ВАЅІС-01' }, { text: 'КМ-04' }];
  const saved = JSON.stringify(originals);
  const recognized = { words: [{ text: 'BASIC-01', top: 16, height: 40, confidence: 95 }] };
  const alternatives = identifiers.alternatives(originals, recognized);
  assert.deepEqual(alternatives, [{ original: 'ВАЅІС-01', latin: 'BASIC-01' }]);
  assert.equal(JSON.stringify(originals), saved);
  assert.match(identifiers.note(alternatives), /unverified/);
  for (const text of ['BASIC-07', 'BAS-01', '15.10.2026', '137,50']) {
    assert.deepEqual(identifiers.alternatives(originals, { words: [{ ...recognized.words[0], text }] }), []);
  }
  assert.deepEqual(identifiers.alternatives(originals, { words: [{ ...recognized.words[0], confidence: 40 }] }), []);
  assert.equal(identifiers.budget(51000, 0, 0), 0);
  assert.equal(identifiers.budget(0, 0, 10000), 0);
  assert.equal(identifiers.budget(0, 0, 0), 2500);
});

function pageImage() {
  return require('node:fs').readFileSync(path.join(__dirname, 'fixtures/mixed-scripts.png'));
}
function scannedPdf(image) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false }), chunks = [];
    doc.on('data', b => chunks.push(b)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    for (let i = 0; i < 4; i++) { doc.addPage({ size: 'A4' }); doc.image(image, 0, 0, { width: 595.28, height: 841.89 }); }
    doc.end();
  });
}
function verify(text) {
  // An ambiguity is explicitly reported, not silently replaced in the primary text.
  for (const code of ['BASIC-01', 'RELOAD-02', 'CANCEL-03']) assert.ok(text.includes(code), code);
  const primary = text.split('[OCR IDENTIFIER ALTERNATIVES')[0];
  const markers = ['ПЕРЕВІРКА', 'Порядок рядків', '15.10.2026', 'Кількість 11', '137,50', 'English:', 'Polski:', 'Наступний рядок'];
  let previous = -1;
  for (const marker of markers) { const position = primary.indexOf(marker); assert.ok(position > previous, marker); previous = position; }
  assert.match(primary, /Zażółć gęślą jaźń/);
  if (text.includes('[OCR IDENTIFIER ALTERNATIVES')) assert.match(text, /OCR QUALITY UNCERTAIN/);
}
test('real raw OCR of mixed Ukrainian/English/Polish PNG and four-page scan retains codes or labelled alternatives, row order, date and amount', async () => {
  process.env.OCR_LANGUAGES = 'auto';
  const image = pageImage();
  const png = await extract(image, 'image');
  if (process.env.OCR_TEST_ARTIFACT_DIR) { const fs = require('node:fs'); fs.mkdirSync(process.env.OCR_TEST_ARTIFACT_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.OCR_TEST_ARTIFACT_DIR, 'mixed.png'), image); fs.writeFileSync(path.join(process.env.OCR_TEST_ARTIFACT_DIR, 'png-raw.txt'), png.text); }
  verify(png.text);
  const pdfBytes = await scannedPdf(image);
  const pdf = await extract(pdfBytes, 'pdf');
  if (process.env.OCR_TEST_ARTIFACT_DIR) { const fs = require('node:fs'); fs.writeFileSync(path.join(process.env.OCR_TEST_ARTIFACT_DIR, 'mixed-4-pages.pdf'), pdfBytes); fs.writeFileSync(path.join(process.env.OCR_TEST_ARTIFACT_DIR, 'pdf-raw.txt'), pdf.text); }
  assert.equal(pdf.pages, 4);
  for (let i = 1; i <= 4; i++) {
    const section = pdf.text.split(`[PDF PAGE ${i} OF 4 — OCR]`)[1]?.split('[PDF PAGE ')[0];
    assert.ok(section); verify(section);
  }
  assert.ok(pdf.detections.every(d => d.models.includes('script/Latin') || d.models.includes('Latin')));
});


test('CANCEL segmentation tolerates one extra/missing letter without changing primary or numeric suffix', () => {
  for (const suffix of ['01', '02', '04', '06']) {
    const originals = [{ text: 'САМъСЕГ-' + suffix }];
    const saved = JSON.stringify(originals);
    const word = { text: 'CANCEL-' + suffix, top: 16, height: 40, confidence: 95 };
    assert.equal(identifiers.candidates(originals).length, 1);
    assert.deepEqual(identifiers.alternatives(originals, { words: [word] }), [{ original: originals[0].text, latin: word.text }]);
    assert.equal(JSON.stringify(originals), saved);
    for (const rejected of [{ ...word, text: 'CANCEL-99' }, { ...word, confidence: 79 }, { ...word, text: 'CAN-' + suffix }]) {
      assert.deepEqual(identifiers.alternatives(originals, { words: [rejected] }), []);
    }
    const reasons = {};
    assert.deepEqual(identifiers.alternatives(originals, { words: [word, { ...word, text: 'EXTRA' }] }, reasons), []);
    assert.deepEqual(reasons, { wordCount: 1 });
    identifiers.alternatives(originals, { words: [{ ...word, text: 'CANCEL-99' }] }, reasons);
    assert.equal(reasons.numericSuffix, 1);
  }
  const short = [{ text: 'САМСГ-01' }];
  assert.equal(identifiers.alternatives(short, { words: [{ text: 'CANCEL-01', top: 16, height: 40, confidence: 95 }] }).length, 1);
});
