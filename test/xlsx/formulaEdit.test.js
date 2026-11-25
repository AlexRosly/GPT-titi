const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const engine = require('../../src/services/xlsx/engine');
const formula = require('../../src/services/xlsx/formula');
const policy = require('../../src/services/xlsx/policy');

const op = (range, formula) => ({type:'set_formula',range,formula});
const query = (sheet,range) => ({sheet,range,where:null,offset:0});
async function source() {
  const wb = new ExcelJS.Workbook();
  const data = wb.addWorksheet('Input Data'), result = wb.addWorksheet('Result');
  data.addRow([2,8.81]);
  data.addRow([21.5,8.81]);
  data.addRow([1.5,35.61]);
  data.addRow([-1.5,35.61]);
  data.fillFormula('C1:C4','A1*B1',[17.62,189.415,53.415,-53.415]);
  data.getColumn('C').numFmt = '#,##0.00';
  data.getCell('A5').value = 'Total';
  data.getCell('C5').value = {formula:'SUM(C1:C4)',result:0};
  result.getCell('B1').value = {formula:"'Input Data'!C5+1",result:1};
  return engine.load(Buffer.from(await wb.xlsx.writeBuffer()));
}
function plan(book,range,operations) {
  const {selection} = engine.inspect(book,query('Input Data',range));
  const args=policy.parse('edit_xlsx',JSON.stringify({fileId:'abcdef123456abcdef123456',sourceChecksum:book.checksum,filename:'result.xlsx',selectionId:selection.id,expectedRows:selection.matchingRows,operations}));
  return {selection,args};
}
async function edit(book,range,operations) {
  const {selection,args} = plan(book,range,operations);
  const records = [...engine.chunks(book,args,selection)].map(c=>({...c,hash:engine.hash(c.xml)}));
  const {report,buffer}=await engine.assemble(book,args,selection,records);
  return {book:engine.load(buffer),report};
}
const rows = (book,sheet,range) => engine.inspect(book,query(sheet,range)).items.flatMap(r=>r.cells);

test('fill relative, absolute and mixed A1 ranges across rows and columns; quoted sheet names stay literal',()=>{
  assert.equal(formula.parse("SUM('Unit A1''s'!A1:B2,$A$1,$A1,A$1)",2,3).expression,
    "SUM('Unit A1''s'!C4:D5,$A$1,$A4,C$1)");
  assert.throws(()=>formula.parse('XFD1',1,0),/REFERENCE/);
});

for (const [range,base] of [['C1:C2','C1'],['C2:C3','C2']]) {
  test('partial replacement of shared formulas starting at '+base+' preserves followers and refreshes cross-sheet dependents',async()=>{
    const original=await source(), {book,report}=await edit(original,range,[op(range,'ROUND(A'+base.slice(1)+'*B'+base.slice(1)+',2)')]);
    const cells=rows(book,'Input Data','C1:C5');
    for (const c of cells.slice(0,4)) {
      const i=Number(c.cell.slice(1)), inside= i>=Number(base.slice(1)) && i<=Number(base.slice(1))+1;
      assert.equal(c.definition.expression,inside?'ROUND(A'+i+'*B'+i+',2)':'A'+i+'*B'+i);
      assert.equal(c.numberFormat,'#,##0.00');
    }
    assert.equal(cells[1].value,189.42);
    assert.ok(Math.abs(cells[4].value-(range==='C1:C2'?207.04:207.045))<1e-9);
    assert.equal(rows(book,'Result','B1')[0].value,cells[4].value+1);
    assert.equal(report.verifiedFormulas,6);
    assert.equal(rows(original,'Input Data','C2')[0].definition.type,'shared');
  });
}

test('insert numeric formulas into empty cells on existing rows, fill a rectangle and keep formulas outside it',async()=>{
  const {book}=await edit(await source(),'D1:E4',[op('D1:E4','ROUND($A1*B$1,2)')]);
  const cells=rows(book,'Input Data','D1:E4');
  assert.equal(cells.length,8);
  assert.deepEqual(cells.slice(-2).map(c=>[c.definition.expression,c.value]),[['ROUND($A4*B$1,2)',-13.22],['ROUND($A4*C$1,2)',-26.43]]);
  assert.equal(rows(book,'Input Data','C2')[0].definition.type,'shared');
});
test('formula cell and range in one transaction; zero, negative midpoints and over-stale cached totals',async()=>{
  const {book,report}=await edit(await source(),'C1:D5',[op('C2:C4','ROUND(A2*B2,2)'),op('C5','SUM(C2:C4)'),op('D5','ROUND(-0.004,2)')]);
  assert.deepEqual(rows(book,'Input Data','C2:C5').map(c=>c.value),[189.42,53.42,-53.42,189.42]);
  assert.equal(rows(book,'Input Data','D5')[0].value,0);
  assert.equal(report.formulaTargets,5);
});
test('unsafe or unverified formula plans fail before a result is returned',async()=>{
  const book=await source();
  for(const [range,ops,pattern] of [
    ['D1',[op('D1','[Other.xlsx]Sheet1!A1')],/UNSUPPORTED/],
    ['D1',[op('D1',"'Missing'!A1")],/SHEET_NOT_FOUND.*D1/],
    ['D1',[op('D1','D1')],/CYCLE.*D1/],
    ['D1',[op('D1','1\/0')],/DIV_ZERO.*D1/],
    ['D1',[op('D1','ABS(A1)')],/UNSUPPORTED/],
    ['D1:D4',[op('D1:D3','1'),op('D3:D4','2')],/OVERLAP/],
    ['D1:D6',[op('D6','1')],/ROW_MISSING/],
    ['D1',[op('D2','1')],/INVALID_RANGE/],
    ['C1:D1',[op('C1','1'),{type:'set_value',column:'D',value:2,expected:null}],/MIXED_ACTIONS/]
  ]) await assert.rejects(edit(book,range,ops),pattern);
  assert.throws(()=>engine.inspect(book,query('Absent','D1')),/SHEET_NOT_FOUND/);
});
test('literal equals-prefixed text stays literal and numeric edits still skip formula cells',async()=>{
  const {book}=await edit(await source(),'C1:D1',[
    {type:'multiply',column:'C',value:2,expected:null},
    {type:'set_value',column:'D',value:'=1+1',expected:null}
  ]);
  const [c,d]=rows(book,'Input Data','C1:D1');
  assert.equal(c.formula,true);assert.equal(c.value,17.62);
  assert.equal(d.formula,false);assert.equal(d.value,'=1+1');
});
test('assembly rejects a modified checkpoint even with a new content hash',async()=>{
  const book=await source(), {args,selection}=plan(book,'C2:C3',[op('C2:C3','ROUND(A2*B2,2)')]);
  const [record]=[...engine.chunks(book,args,selection)];
  record.xml=record.xml.replace('ROUND(A2*B2,2)','123');
  record.hash=engine.hash(record.xml);
  await assert.rejects(engine.assemble(book,args,selection,[record]),/CHECKPOINT_INVALID/);
});
