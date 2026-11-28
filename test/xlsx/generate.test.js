const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const artifacts = require('../../src/services/files/artifacts');
const office = require('../../src/services/files/office');
const engine = require('../../src/services/xlsx/engine');
const {creationManifest} = require('./fixtures');

const file = {filename:'budget.xlsx'};
const render = manifest => artifacts.renderOutput(file, JSON.stringify(manifest));
const f = formula => ({type:'formula', formula});
const read = async buffer => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  return book;
};

test('new workbook stores formulas, numeric formats and preview; editing a quantity refreshes both sheets', async () => {
  const created = await render(creationManifest());
  const book = await read(created.buffer);
  assert.deepEqual(book.worksheets.map(s => s.name), ['Дані','Підсумок']);
  const [data, summary] = book.worksheets;
  assert.equal(data.getCell('C3').value, 4.5);
  for (const cell of [data.getCell('C2'),data.getCell('C3'),data.getCell('D2'),data.getCell('D3'),summary.getCell('B2')]) {
    assert.equal(cell.numFmt, '0.00');
  }
  assert.deepEqual(data.getCell('D2').value, {formula:'ROUND(B2*C2,2)', result:20.5});
  assert.deepEqual(data.getCell('D3').value, {formula:'ROUND(B3*C3,2)', result:13.5});
  assert.deepEqual(summary.getCell('B2').value, {formula:"SUM('Дані'!D2:D3)", result:34});
  assert.deepEqual(created.generatedPreview.sheets[0].rows[1], ['Папка',2,10.25,20.5]);
  assert.deepEqual(created.generatedPreview.sheets[1].rows[1], ['Разом',34]);

  const original = engine.load(created.buffer);
  const {selection} = engine.inspect(original, {sheet:'Дані',range:'B2',where:null,offset:0});
  const args = {sourceChecksum:original.checksum,selectionId:selection.id,expectedRows:1,
    operations:[{type:'set_value',column:'B',value:3,expected:null}]};
  const chunks = Array.from(engine.chunks(original,args,selection), chunk => ({...chunk,hash:engine.hash(chunk.xml)}));
  const edited = await engine.assemble(original,args,selection,chunks);
  const updated = await read(edited.buffer);
  assert.equal(updated.getWorksheet('Дані').getCell('D2').result, 30.75);
  assert.deepEqual(updated.getWorksheet('Підсумок').getCell('B2').value, {formula:"SUM('Дані'!D2:D3)", result:44.25});
  assert.equal(edited.report.verifiedFormulas, 2);
});

test('forward, mixed and quoted references, cached zero and literal equals coexist', async () => {
  const source = {sheets:[
    {name:'Totals',rows:[[f("SUM('Q1 O''Brien'!$A$1:B1)+B1"), f('C1/2'), 8, '=1+2', false, null]]},
    {name:"Q1 O'Brien",rows:[[{type:'number',value:-7.5,numberFormat:'#,##0.00'}, f('ROUND(-A$1,1)')], [f('A1+B1')]]},
  ]};
  const output = await render(source);
  const book = await read(output.buffer);
  assert.equal(book.worksheets[0].getCell('A1').result, 4);
  assert.equal(book.worksheets[0].getCell('D1').type, ExcelJS.ValueType.String);
  assert.equal(book.worksheets[1].getCell('A2').result, 0);
  assert.deepEqual(output.generatedPreview.sheets[0].rows[0], [4,4,8,'=1+2',false,null]);
  const zip = await JSZip.loadAsync(output.buffer);
  assert.match(await zip.file('xl/worksheets/sheet2.xml').async('string'), /<f>A1\+B1<\/f><v>0<\/v>/);
});

test('typed cells accept only numeric inputs, declared formats and server-computed results', () => {
  for (const cell of [
    {type:'formula',formula:'1+2',result:3}, {type:'formula',formula:'1',value:1},
    {type:'formula',formula:'1',numberFormat:'invalid'}, {type:'number',value:'2'},
    {type:'number',value:2,formula:'1+1'}, {type:'formula',formula:' '},
    {type:'number',value:1,numberFormat:null}, {type:'number',value:null}, {formula:'1+1'},
  ]) {
    assert.throws(() => office.validate('xlsx', JSON.stringify({sheets:[{name:'Data',rows:[[cell]]}]})), /INVALID_DOCUMENT_CONTENT/);
  }
  for (const tool of [artifacts.toolOptions(file), artifacts.autoToolOptions()]) {
    assert.match(tool.tools[0].function.description, /"type":"formula"/);
    assert.match(tool.tools[0].function.description, /"numberFormat":"0\.00"/);
  }
});

test('literal codes and line endings survive alongside a working formula', async () => {
  const values = ['=_x0041_', '_x0041_x0042_', 'a\r\nb', '\r', '', null, false];
  const output = await render({sheets:[{name:'Codes',rows:[values,[f('1-1')]]}]});
  assert.deepEqual(output.generatedPreview.sheets[0].rows[0], values);
  const saved = await read(output.buffer);
  assert.equal(saved.worksheets[0].getCell('A1').type, ExcelJS.ValueType.String);
});

test('formatted numbers also work without formulas and keep their raw values in the next inspection', async () => {
  const formats = ['General','0','0.00','#,##0','#,##0.00','0%','0.00%'];
  const row = formats.map(numberFormat => ({type:'number',value:0.25,numberFormat}));
  const result = await render({sheets:[{name:'Data',rows:[row]}]});
  assert.deepEqual(result.generatedPreview.sheets[0].rows[0], formats.map(() => 0.25));
  const {items} = engine.inspect(engine.load(result.buffer),{sheet:'Data',range:'A1:G1',where:null,offset:0});
  assert.deepEqual(items[0].cells.map(c => c.numberFormat ?? 'General'), formats);
});

test('unsupported, circular, external, erroneous and oversized calculations fail at their cell', async () => {
  for (const [expression, error] of [
    ['IF(1,2,3)','XLSX_FORMULA_UNSUPPORTED'], ['[Other.xlsx]Data!B1','XLSX_FORMULA_UNSUPPORTED'],
    ["'Other'!A1",'XLSX_FORMULA_SHEET_NOT_FOUND'], ['B1/0','XLSX_FORMULA_DIV_ZERO'],
    ['A1+1','XLSX_FORMULA_CYCLE'], ['B1+1','XLSX_FORMULA_NON_NUMERIC'],
    ['SUM(C1:C1048576)','XLSX_FORMULA_LIMIT'],
  ]) {
    const secondCell = expression === 'B1+1' ? '=code' : 1;
    await assert.rejects(render({sheets:[{name:'Data',rows:[[f(expression),secondCell]]}]}), {fileError:error+' (Data!A1)'});
  }
  await assert.rejects(render({sheets:[{name:'A',rows:[[f('B!A1')]]},{name:'B',rows:[[f('A!A1')]]}]}), /XLSX_FORMULA_CYCLE/);
});

test('a changed cache in the serialized workbook prevents publication', async t => {
  const codec = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx);
  const write = codec.writeBuffer;
  t.mock.method(codec, 'writeBuffer', async function (...args) {
    const zip = await JSZip.loadAsync(await write.apply(this,args));
    const path = 'xl/worksheets/sheet2.xml';
    const xml = await zip.file(path).async('string');
    assert.match(xml, /<v>34<\/v>/);
    zip.file(path, xml.replace('<v>34</v>', '<v>43</v>'));
    return zip.generateAsync({type:'nodebuffer'});
  });
  await assert.rejects(require('../../src/services/xlsx/generate')(creationManifest(),8*1024**2),
    {fileError:'XLSX_VERIFICATION_FAILED (Підсумок!B2)'});
});
