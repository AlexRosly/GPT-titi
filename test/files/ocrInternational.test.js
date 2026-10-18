const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const policy = require('../../src/services/files/ocrLanguages');
const { extract } = require('../../src/services/files/ocrProcess');
process.env.OCR_LANGUAGES = 'auto';
const image = name => fs.readFileSync(path.join(__dirname, 'fixtures/international', name + '.png'));
const available = new Set(['osd', ...policy.SCRIPTS.map(s => 'script/' + s)]);
test('international mode defaults to auto and validates administrator overrides', () => {
  delete process.env.OCR_LANGUAGES; assert.equal(policy.mode(), 'auto');
  for (const value of ['../../secret','eng;pwd','script/../Latin','auto+eng','osd+eng','']) {
    if (!value) continue;
    process.env.OCR_LANGUAGES = value;
    assert.throws(() => policy.mode(), { fileError: 'OCR_UNAVAILABLE' });
  }
  process.env.OCR_LANGUAGES = 'auto';
});
test('all 33 script models are required and distro/root aliases resolve safely', () => {
  assert.equal(policy.SCRIPTS.length, 33); assert.deepEqual(policy.missing('auto', available), []);
  const root = new Set(['osd', ...policy.SCRIPTS]); assert.deepEqual(policy.missing('auto', root), []);
  assert.ok(policy.missing('auto', new Set(['osd','eng'])).includes('script/Arabic'));
  for (const script of policy.SCRIPTS) {
    const result = policy.select('auto', available, { script, confidence: 10 });
    assert.ok(result.models.length <= 4); assert.equal(result.uncertain, false);
    assert.ok(result.models.includes('script/' + script));
  }
});
test('Han ambiguity is bounded; low-confidence and missing detection are disclosed', () => {
  const han = policy.select('auto', available, policy.parseOsd('Script: Han\nScript confidence: 8.1\n'));
  assert.deepEqual(han.models, ['script/HanS', 'script/HanT']);
  const unknown = policy.select('auto', available, { script: null, confidence: null });
  assert.equal(unknown.uncertain, true); assert.equal(unknown.models.length, 4);
  assert.equal(policy.select('auto', available, { script: 'Hebrew', confidence: 0.5 }).uncertain, true);
  assert.equal(policy.parseOsd('Script: ../../bad\nScript confidence: NaN').script, null);
  assert.throws(() => policy.select('auto', new Set(['osd']), { script: 'Arabic', confidence: 10 }), { fileError: 'OCR_UNAVAILABLE' });
});
test('low script agreement triggers only a bounded layout retry', () => {
  assert.equal(policy.scriptQuality('Korean', 'fake Latin output lots of words 입니').retryLayout, true);
  assert.equal(policy.scriptQuality('Korean', '한국어 문서 번호입니다').retryLayout, false);
  assert.equal(policy.scriptQuality('Latin', 'invoice text').retryLayout, false);
});
const cases = [
  ['latin','Latin',/facture/i], ['cyrillic','Cyrillic',/Україна/], ['greek','Greek',/Ελληνικό/],
  ['arabic','Arabic',/العربية/], ['hebrew','Hebrew',/בעברית/], ['chinese','Han',/中文测试文件/],
  ['chinese-traditional','Han',/中文測試文件/],
  ['japanese','Japanese',/日本語/], ['korean','Korean',/한국어/], ['hindi','Devanagari',/हिंदी/],
];
for (const [name, script, expected] of cases) {
  test(`real automatic OCR: ${name}, without a user language selection`, async () => {
    const result = await extract(image(name), 'image');
    assert.equal(result.languages, 'auto');
    if (name === 'chinese-traditional') assert.ok(['Han', 'Japanese'].includes(result.detections[0].script));
    else assert.equal(result.detections[0].script, script);
    assert.ok(result.detections[0].models.length <= 4);
    assert.match(result.text.replace(/\s/g, ''), expected); assert.match(result.text, /731/);
    if (result.detections[0].uncertain) assert.match(result.text, /(?:SCRIPT SELECTION|OCR QUALITY) UNCERTAIN/);
  });
}
test('one PDF chooses different scripts per physical page and preserves metadata', async () => {
  const buffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false }), chunks = [];
    doc.on('data', b => chunks.push(b)); doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));
    for (const name of ['arabic','chinese']) { doc.addPage(); doc.image(image(name), 25, 40, { width: 560 }); }
    doc.end();
  });
  const result = await extract(buffer, 'pdf');
  assert.deepEqual(result.detections.map(d => d.page), [1, 2]);
  assert.equal(result.detections[0].script, 'Arabic');
  assert.ok(['Han', 'Japanese'].includes(result.detections[1].script));
  assert.match(result.text, /PDF PAGE 1 OF 2/); assert.match(result.text, /PDF PAGE 2 OF 2/);
  assert.match(result.text, /العربية/); assert.match(result.text.replace(/\s/g,''), /中文测试文件/);
});

test('auto mode discloses the bounded fallback on a blank image without inventing text', async () => {
  const { makeImage } = require('./fixtures/ocr');
  const result = await extract(makeImage(''), 'image');
  assert.equal(result.detections[0].uncertain, true);
  assert.equal(result.detections[0].models.length, 4);
  assert.match(result.text, /NO TEXT RECOGNIZED/);
  assert.match(result.text, /SCRIPT SELECTION UNCERTAIN/);
});
