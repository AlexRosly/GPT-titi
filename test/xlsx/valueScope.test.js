const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const engine = require('../../src/services/xlsx/engine');
const policy = require('../../src/services/xlsx/policy');
const {creationManifest} = require('./fixtures');

let book;
test.before(async () => {
  const manifest = creationManifest();
  manifest.sheets[0].rows[1][1] = 3;
  const {buffer} = await require('../../src/services/files/artifacts')
    .renderOutput({filename:'source.xlsx'}, JSON.stringify(manifest));
  book = engine.load(buffer);
});

function inspect(range, where = null) {
  return engine.inspect(book, {sheet:'Дані',range,where,offset:0}).selection;
}

function plan(selection, operations) {
  const args = policy.parse('edit_xlsx', JSON.stringify({
    fileId:'0123456789abcdef01234567',sourceChecksum:book.checksum,filename:'edited.xlsx',
    selectionId:selection.id,expectedRows:selection.matchingRows,operations,
  }));
  return {...args,operations:policy.valueOperations(args.operations,selection)};
}

const setTwo = {type:'set_value',column:'B',value:2,expected:null};
const fill = range => ({type:'fill_value',range,value:2});

test('a literal edit of one record requires a single match, including on filtered selections', () => {
  const quantity = {column:'B',operator:'equals',value:3};
  const item = {column:'A',operator:'equals',value:'Папка'};
  for (const selection of [inspect(null), inspect('B2:B3'), inspect(null,quantity)]) {
    assert.throws(() => plan(selection,[setTwo]),{fileError:'XLSX_SINGLE_ROW_REQUIRED'});
  }
  for (const selection of [inspect('B2'), inspect(null,item)]) {
    assert.deepEqual(plan(selection,[setTwo]).operations,[setTwo]);
  }
});

test('bulk literal fills require the inspected data bounds and preserve a matched filter header', async () => {
  assert.throws(() => plan(inspect(null),[fill('B1:B3')]),{fileError:'XLSX_FILL_SCOPE_REQUIRED'});
  assert.throws(() => plan(inspect('A1:D3'),[fill('B1:B3')]),{fileError:'XLSX_FILL_HEADER'});
  assert.throws(() => plan(inspect('A2:D3'),[fill('B2')]),{fileError:'XLSX_FILL_SCOPE_REQUIRED'});
  assert.throws(() => plan(inspect('A2:D3'),[fill('B2:C3')]),{fileError:'XLSX_INVALID_RANGE'});
  assert.throws(() => plan(inspect('A2:D3'),[fill('E2:E3')]),{fileError:'XLSX_FILL_SCOPE_REQUIRED'});
  assert.throws(() => plan(inspect('A2:D3'),[fill('B2:B3'),fill('B2:B3')]),{fileError:'XLSX_INVALID_ACTION'});
  const selection = inspect('A2:D3');
  const args = plan(selection,[fill('B2:B3')]);
  const chunks = Array.from(engine.chunks(book,args,selection), row => ({...row,hash:engine.hash(row.xml)}));
  const output = await engine.assemble(book,args,selection,chunks);
  const copy = new ExcelJS.Workbook();
  await copy.xlsx.load(output.buffer);
  assert.equal(output.report.changed,2);
  assert.deepEqual(copy.getWorksheet('Дані').getColumn('B').values.slice(1),['Кількість',2,2]);
  assert.equal(copy.getWorksheet('Підсумок').getCell('B2').result,29.5);
  const filtered = inspect(null,{column:'B',operator:'equals',value:3});
  assert.deepEqual(plan(filtered,[fill('B1:B3')]).operations,[setTwo]);
});
