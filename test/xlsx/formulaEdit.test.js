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

const setNumber = (column,value) => ({type:'set_value',column,value,expected:null});
const cached = (book,sheet,range) => rows(book,sheet,range).map(c=>c.value);
async function numericBook(fill) {
  const wb = new ExcelJS.Workbook();
  fill(wb.addWorksheet('Input Data'),wb.addWorksheet('Totals'));
  return engine.load(Buffer.from(await wb.xlsx.writeBuffer()));
}

test('one quantity edit refreshes stored cents and a cross-sheet range total before any editor opens',async()=>{
  const original=await numericBook((data,totals)=>{
    data.addRow([21.5,8.81,{formula:'ROUND(A1*B1,2)',result:189.42}]);
    data.addRow([1.5,35.61,{formula:'ROUND(A2*B2,2)',result:53.42}]);
    totals.getCell('A1').value={formula:"SUM('Input Data'!$C$1:C2)",result:242.84};
    totals.getCell('A2').value={formula:'A1*2',result:485.68};
    totals.getCell('B1').value={formula:'42',result:41};
  });
  const {book,report}=await edit(original,'A1',[setNumber('A',20)]);
  assert.deepEqual(cached(book,'Input Data','C1:C2'),[176.2,53.42]);
  assert.deepEqual(cached(book,'Totals','A1:A2'),[229.62,459.24]);
  assert.deepEqual(cached(book,'Totals','B1'),[41]); // unrelated cache, as supplied
  assert.deepEqual(cached(original,'Input Data','C1'),[189.42]);
  assert.equal(report.changed,1);assert.equal(report.verifiedFormulas,3);
  assert.equal(report.valueRecalculation.unverifiedCount,0);
  const summary=require('../../src/services/documentJobs/adapters').get('xlsx-v1').summary(report);
  assert.match(summary,/verified 3 dependent formula results/);
});

test('filtered input changes update only actual dependents and keep shared formula definitions',async()=>{
  const original=await source(),range='A1:C4';
  const selection=engine.inspect(original,{...query('Input Data',range),where:{column:'A',operator:'gt',value:20}}).selection;
  const args={selectionId:selection.id,sourceChecksum:original.checksum,expectedRows:1,operations:[setNumber('A',20)]};
  const chunks=Array.from(engine.chunks(original,args,selection),chunk=>({...chunk,hash:engine.hash(chunk.xml)}));
  const result=await engine.assemble(original,args,selection,chunks);
  const updated=engine.load(result.buffer);
  const [before,after]=[original,updated].map(b=>rows(b,'Input Data','C2')[0]);
  assert.deepEqual(after.definition,before.definition);
  assert.equal(after.value,20*8.81);assert.equal(result.report.verifiedFormulas,3);
  assert.deepEqual(cached(original,'Input Data','C1'),cached(updated,'Input Data','C1'));
});

test('unsupported dependent and opaque formulas lose stale caches, independent formulas and valid branches survive',async()=>{
  const original=await numericBook((data,totals)=>{
    data.addRow([2,11,{formula:'A1*2',result:4},{formula:'ABS(A1)',result:2},{formula:'ABS(B1)',result:11}]);
    data.getCell('F1').value={formula:'INDIRECT("A1")',result:2};
    totals.addRow([{formula:"'Input Data'!D1+1",result:3},{formula:"'Input Data'!C1+1",result:5}]);
  });
  const {book,report}=await edit(original,'A1',[setNumber('A',7)]);
  assert.deepEqual(cached(book,'Input Data','C1:F1'),[14,null,11,null]);
  assert.deepEqual(cached(book,'Totals','A1:B1'),[null,15]);
  const inspected=engine.inspect(book,query('Totals','A1'));
  assert.equal(inspected.items[0].cells[0].cachedResult,'missing');
  assert.equal(inspected.statistics[0].missingFormulaResults,1);
  assert.equal(inspected.statistics[0].sum,null);
  assert.deepEqual(cached(original,'Totals','A1:B1'),[3,5]);
  const status=report.valueRecalculation;
  assert.equal(status.verifiedCount,2);assert.equal(status.unverifiedCount,3);
  assert.equal(report.formulaValuesRecalculated,false);
  assert.deepEqual(new Set(status.unverifiedSample.map(x=>x.sheet+'!'+x.cell)),
    new Set(['Input Data!D1','Input Data!F1','Totals!A1']));
  const summary=require('../../src/services/documentJobs/adapters').get('xlsx-v1').summary(report);
  assert.match(summary,/full recalculation/);assert.match(summary,/Totals!A1/);
});

test('an edit that introduces division by zero clears its branch, leaves a separate cycle and supports zero and blank',async()=>{
  const original=await numericBook(data=>{
    data.addRow([2,{formula:'1/A1',result:0.5},{formula:'B1*2',result:1},
      {formula:'A1+2',result:4},{formula:'F1',result:9},{formula:'E1',result:9}]);
    data.getCell('G1').value={formula:'H1+1',result:1};
  });
  const {book,report}=await edit(original,'A1',[setNumber('A',0)]);
  assert.deepEqual(cached(book,'Input Data','B1:F1'),[null,null,2,9,9]);
  assert.equal(report.valueRecalculation.unverifiedCount,2);
  const restored=await edit(book,'A1',[setNumber('A',4)]);
  assert.deepEqual(cached(restored.book,'Input Data','B1:D1'),[0.25,0.5,6]);
  const inserted=await edit(original,'H1',[setNumber('H',-2)]);
  assert.deepEqual(cached(inserted.book,'Input Data','G1:H1'),[-1,-2]);
  const cleared=await edit(inserted.book,'H1',[setNumber('H',null)]);
  assert.deepEqual(cached(cleared.book,'Input Data','G1:H1'),[1,null]);
  const noop=await edit(original,'A1',[setNumber('A',2)]);
  assert.equal(noop.report.changed,0);assert.equal(noop.report.verifiedFormulas,0);
});

test('changed array cache, its follower and a cross-sheet dependent all require native recalculation',async()=>{
  const original=await numericBook((data,totals)=>{
    data.addRow([2,3]);
    data.fillFormula('C1:D1','A1:B1*2',[4,6],'array');
    totals.getCell('A1').value={formula:"'Input Data'!D1+1",result:7};
  });
  const {book,report}=await edit(original,'A1',[setNumber('A',4)]);
  assert.equal(rows(book,'Input Data','C1')[0].definition.type,'array');
  assert.deepEqual(cached(book,'Input Data','C1:D1'),[null,null]);
  assert.deepEqual(cached(book,'Totals','A1'),[null]);
  assert.equal(report.valueRecalculation.clearedRangeCells,1);
});

test('a range beyond the evaluation budget can coexist with a verified result and an unrelated range',async()=>{
  const original=await numericBook(data=>{
    data.addRow([2,7,{formula:'SUM(A1:A1048576)',result:2},{formula:'A1*3',result:6},
      {formula:'SUM(B1:B1048576)',result:7}]);
  });
  const {book,report}=await edit(original,'A1',[setNumber('A',5)]);
  assert.deepEqual(cached(book,'Input Data','C1:E1'),[null,15,7]);
  assert.equal(report.valueRecalculation.unverifiedSample[0].reason,'XLSX_FORMULA_LIMIT');
});
