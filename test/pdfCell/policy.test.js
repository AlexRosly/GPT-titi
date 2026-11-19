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

const amountPrompt = 'У прикріпленому PDF на сторінці 2 у рядку «QA-202» у колонці «Сума, грн» заміни «760,18» на «7606,18». Зміни тільки цю клітинку. Поверни копію з назвою QA_PDF_amount_result.pdf.';

test('the live amount request selects the verified PDF editor with or without a preservation instruction', () => {
  const expected = {
    profile:'pdf-table-number-v1', fileId:file.fileId, filename:'QA_PDF_amount_result.pdf',
    cell:{page_number:2, row_key:'QA-202', column:'Сума, грн', old:'760,18', new:'7606,18'},
  };
  for (const instruction of ['', 'Зміни тільки цю клітинку.', 'Зміни лише цю клітинку.',
    'Збережи решту тексту й оформлення.', 'Зміни тільки цю клітинку. Збережи решту тексту й оформлення.']) {
    assert.deepEqual(pdf.plan(amountPrompt.replace('Зміни тільки цю клітинку.', instruction), [file], {}), expected);
  }
});

test('a single-cell qualifier cannot hide another requested edit', () => {
  for (const instruction of ['Зміни тільки цю клітинку і рядок «QA-203».',
    'Зміни тільки цю клітинку. Видали першу сторінку.']) {
    assert.equal(pdf.plan(amountPrompt.replace('Зміни тільки цю клітинку.', instruction), [file], {}), null);
  }
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
