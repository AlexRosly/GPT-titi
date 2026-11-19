const test = require('node:test');
const assert = require('node:assert/strict');
const pdf = require('../../src/services/pdfCell');
const file = {storage:'private', originalName:'source.pdf', fileId:'0123456789abcdef01234567'};
const prompt = 'У PDF на сторінці 2 у рядку «QA-202» у колонці «Дата» заміни «13.11.2026» на «07.11.2026». Поверни копію з назвою QA_PDF_date_result.pdf.';
Object.assign(process.env,{PRIVATE_FILES_ENABLED:'true',COMPUTE_V2_ENABLED:'true',PDF_CELL_EDIT_ENABLED:'true'});

test('request selector binds one physical page, row, column, old value and new filename', () => {
  const p = pdf.plan(prompt, [file], {});
  assert.deepEqual(p.cell, {page_number:2,row_key:'QA-202',column:'Дата',old:'13.11.2026',new:'07.11.2026'});
  assert.equal(p.filename,'QA_PDF_date_result.pdf');
  assert.equal(pdf.plan(prompt+' Та ще зміни всі суми.',[file],{}),null);
  assert.equal(pdf.plan(prompt,[file,file],{}),null);
  for (const model of [{pdfInputEnabled:false},{computationEnabled:false},{fileOutputEnabled:false}])
    assert.equal(pdf.plan(prompt,[file],model), null);
  process.env.PDF_CELL_EDIT_ENABLED='false';
  try { assert.equal(pdf.plan(prompt,[file],{}),null); }
  finally { process.env.PDF_CELL_EDIT_ENABLED='true'; }
});

test('unverified candidates and provider-created artifacts cannot complete a protected turn', () => {
  const turn = {pdfCellPlan:pdf.plan(prompt,[file],{}), providerResult:{artifact:{filename:'fake.pdf'}}};
  assert.deepEqual(pdf.publication(turn).computation.files,[]);
  assert.equal(pdf.completion(turn),null);
});

test('a model cannot replace a selector or read a source outside the current turn', async () => {
  const turn = {pdfCellPlan:pdf.plan(prompt,[file],{})};
  const run = (args, available) => pdf.run({turn,model:{},call:{function:{name:pdf.name,arguments:args}},
    available,completionAllowed:true});
  await assert.rejects(run('{"row":"override"}',[file]),{fileError:'PDF_CELL_INVALID_ACTION'});
  await assert.rejects(run('{}',[]),{fileError:'COMPUTE_FILE_FORBIDDEN'});
});
