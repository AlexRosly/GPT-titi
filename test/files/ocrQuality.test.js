const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTsv, preferAlternative, retryBudget } = require('../../src/services/files/ocrQuality');
const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n';
const word = (text, { block = 1, line = 1, x = 10, width = 200, confidence = 95 } = {}) =>
  `5\t1\t${block}\t1\t${line}\t1\t${x}\t${line * 30}\t${width}\t20\t${confidence}\t${text}\n`;
test('TSV preserves literal quotes, dates, amounts and OCR line/block order, including RTL', () => {
  const raw = header + word('15.40.2026') + word('123 503,60', { line: 2 }) +
    word('"СІЧ"', { block: 2 }) + word('العربية', { block: 3, x: 300 }) + word('731', { block: 3, x: 10 });
  assert.equal(parseTsv(raw).text, '15.40.2026\n123 503,60\n\n"СІЧ"\n\nالعربية 731');
});
test('OCR confidence is disclosed without dropping low-confidence words', () => {
  const result = parseTsv(header + word('UNREADABLE', { confidence: 12 }));
  assert.equal(result.text, 'UNREADABLE'); assert.equal(result.uncertain, true);
  assert.equal(parseTsv(header).text, ''); assert.equal(parseTsv(header).uncertain, false);
  assert.equal(parseTsv(header + word('Readable prose '.repeat(50)) + word('15.40.2026', { line: 2, confidence: 65 })).uncertain, true);
  assert.throws(() => parseTsv('unexpected text'), { fileError: 'OCR_FAILED' });
});
test('two narrow columns do not trigger a single-column layout retry', () => {
  let columns = header, single = header;
  for (let line = 1; line <= 8; line++) {
    columns += word('LEFT', { line, width: 100, confidence: 40 });
    single += word('FULL ROW', { line, width: 500, confidence: 40 });
  }
  for (let line = 1; line <= 8; line++) columns += word('RIGHT', { block: 2, line, x: 400, width: 100, confidence: 40 });
  assert.equal(parseTsv(columns).singleColumn, false);
  assert.equal(parseTsv(single).singleColumn, true);
  assert.ok(parseTsv(columns).text.indexOf('LEFT\nLEFT') < parseTsv(columns).text.indexOf('RIGHT'));
});
test('a high-confidence fragment cannot replace a fuller OCR result', () => {
  const base = { characters: 1000, confidence: 60 };
  assert.equal(preferAlternative(base, { characters: 300, confidence: 99 }), false);
  assert.equal(preferAlternative(base, { characters: 990, confidence: 59 }), false);
  assert.equal(preferAlternative(base, { characters: 990, confidence: 80 }), true);
});
test('optional OCR retries leave time for remaining pages and never extend the job deadline', () => {
  assert.equal(retryBudget(20000, 2, 0), 0);
  assert.equal(retryBudget(10000, 0, 0), 8000);
  assert.equal(retryBudget(28000, 0, 1), 2000);
  assert.equal(retryBudget(29000, 0, 1), 0);
  assert.equal(retryBudget(0, 0, 2), 0);
});
