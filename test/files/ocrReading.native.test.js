const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {extract} = require('../../src/services/files/ocrProcess');

process.env.OCR_LANGUAGES='auto';
process.env.OCR_REGIONS_ENABLED='true';
const fixture = name=>fs.readFileSync(path.join(__dirname,'fixtures/reading',name));

test('public OCR on the two-page Ukrainian table returns the four exact records',async()=>{
  const r = await extract(fixture('table.pdf'),'pdf');
  assert.equal(r.pages,2);
  const rows=r.text.split('\n').filter(line=>/^QA-/.test(line));
  assert.deepEqual(rows,[
    'QA-217 Фарба «Іній» 07.11.2026 760,18','QA-271 Ґудзики сині 13.11.2026 125,50',
    'QA-317 Фарба «Іній» 17.11.2026 7606,18','QA-371 Набір для мозаїки 19.11.2026']);
  assert.doesNotMatch(r.text,/ALTERNATIVES|"latin":|"alternative":/);
});

test('independent scan, same suffix with QA and Cyrillic ОА, upper- and lowercase hooked and plain letters',async()=>{
  const r=await extract(fixture('contrast.png'),'image');
  assert.deepEqual(r.text.split('\n').filter(line=>/^(?:QA|ОА)-/.test(line)),[
    'QA-217 Ґанок синій 07.11.2026 760,18','ОА-217 Голова синя 13.11.2026 125,50',
    'QA-371 ґанок білий 19.11.2026','ОА-371 гора біла 17.11.2026 7606,18']);
  assert.doesNotMatch(r.text,/ALTERNATIVES|"latin":|"alternative":/);
});
