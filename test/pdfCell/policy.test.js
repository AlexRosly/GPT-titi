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

const batch = require('./batchFixture');
const {covers, key} = require('../../src/services/pdfCell/plan');

test('all addressed instructions belong to one plan and saved single-cell keys remain compatible', () => {
  const batchPlan = pdf.plan(batch.prompt, [file], {});
  assert.deepEqual(batchPlan.cells, batch.cells);
  assert.equal(batchPlan.filename, 'QA_PDF_multi_result.pdf');
  assert.equal(pdf.plan(batch.prompt.replace('внеси такі зміни.\n', ''), [file], {}).cells.length, 3);
  assert.equal(pdf.plan(batch.prompt.replace('На сторінці 2', '2) На сторінці 2'), [file], {}).cells.length, 3);
  const original = pdf.plan(prompt, [file], {});
  const legacyFields = ['pdf-table-number-v1',file.fileId,'QA_PDF_date_result.pdf',2,'QA-202','Дата','13.11.2026','07.11.2026'];
  assert.equal(key(original), require('node:crypto').createHash('sha256').update(JSON.stringify(legacyFields)).digest('hex'));
  assert.ok(covers(batchPlan, batch.report));
  for (const report of [{...batch.report, changedPages:1}, {...batch.report, pages:1}, {...batch.report, changedCells:2},
    {...batch.report, verifiedCells:batch.report.verifiedCells.slice(1)}, {...batch.report, verifiedCells:batch.report.verifiedCells.toReversed()}]) {
    assert.equal(covers(batchPlan, report), false);
  }
  assert.equal(covers({...batchPlan, cells:batch.cells.map(c => ({...c, old:'1'}))}, batch.report), false);
});

test('a malformed or oversized explicit list stays on the protected path', () => {
  for (const msg of [batch.prompt.replace('заміни', 'знайди'), batch.prompt+' Видали таблицю.',
    batch.prompt.replace('На сторінці 2', 'Додай ще одну правку. На сторінці 2')]) {
    const plan = pdf.plan(msg, [file], {});
    assert.equal(plan.error, 'PDF_CELL_BATCH_SYNTAX');
    assert.deepEqual(pdf.publication({pdfCellPlan:plan}).computation.files, []);
  }
  const [intro,line,,,end] = batch.prompt.split('\n');
  assert.equal(pdf.plan([intro,...Array(65).fill(line),end].join('\n'), [file], {}).error, 'PDF_CELL_BATCH_SIZE');
});

const textFixture = require('./textFixture');

test('natural scoped edits bind both replacements, options and default output name', () => {
  const p = pdf.plan(textFixture.prompt,[file],{});
  assert.deepEqual(p.text,{scope:textFixture.scope,changes:textFixture.changes});
  assert.equal(pdf.toolFor(p).function.name,'edit_pdf_text');
  assert.equal(p.filename,'source_edited.pdf');
  assert.equal(covers(p,textFixture.report),true);
  assert.equal(covers(p,{...textFixture.report,verifiedTexts:textFixture.report.verifiedTexts.toReversed()}),false);
  assert.equal(covers(p,{...textFixture.report,targetPages:[1,2]}),false);
  assert.equal(pdf.plan(textFixture.prompt+' і видали додаток',[file],{}).error,'PDF_CELL_TEXT_SYNTAX');
  assert.equal(pdf.plan(textFixture.prompt,[file,file],{}),null);
  assert.notEqual(key(p),key({...p,text:{...p.text,scope:{...p.text.scope,party:'QA-100'}}}));
});

test('one request may address different pages, named sections and phrases with punctuation', () => {
  const message = 'На сторінці 1 у розділі «Умови оплати» заміни «10 днів» на «15 днів»; на сторінці 2 заміни «100 грн.» на «150 грн.». Поверни копію з назвою two_pages.pdf.';
  const p = pdf.plan(message,[file],{});
  assert.equal(p.filename,'two_pages.pdf');
  assert.equal(p.text.scope.page,1);
  assert.equal(p.text.changes[1].scope.page,2);
  assert.equal(p.text.changes[1].old,'100 грн.');
  const quoted = pdf.plan('Заміни «Розділ 1, умови та комісії» на «Умови, ціни і комісії».',[file],{});
  assert.equal(quoted.text.changes[0].new,'Умови, ціни і комісії');
  const unsafe = pdf.plan('На сторінці 1 заміни «A» на «B». Перестав сторінки.',[file],{});
  assert.equal(unsafe.error,'PDF_CELL_TEXT_SYNTAX');
});

test('a trailing section qualifier is bound to the target rather than inserted in the PDF', () => {
  const p = pdf.plan('Заміни «10 днів» на «15 днів» у розділі «Умови оплати».',[file],{});
  assert.equal(p.text.changes[0].scope.section,'Умови оплати');
  assert.equal(p.text.changes[0].new,'15 днів');
  assert.equal(pdf.plan('Як замінити текст на інший?',[file],{}),null);
});
