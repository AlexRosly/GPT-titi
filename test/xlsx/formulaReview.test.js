const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const engine = require('../../src/services/xlsx/engine');
const office = require('../../src/services/files/officeInput');
const messages = require('../../src/services/files/messages');
const context = require('../../src/services/files/textContext');
const textInput = require('../../src/services/files/textInput');
const store = require('../../src/services/files/store');

let bytes, book;
test.before(async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Costs');
  const other = wb.addWorksheet('Other');
  sheet.addRow(['Qty', 'Rate', 'Amount']);
  sheet.addRow([1.5, 35.61]);
  sheet.addRow([21.5, 8.81]);
  sheet.fillFormula('C2:C3', 'A2*B2', [53.415, 189.415]);
  sheet.getColumn('C').numFmt = '0.00';
  sheet.getCell('C4').value = { formula: 'SUMPRODUCT(ROUND(C2:C3,2))', result: 242.84 };
  other.getCell('A1').value = { formula: 'Costs!C4' };
  bytes = Buffer.from(await wb.xlsx.writeBuffer());
  book = engine.load(bytes);
});

test('index identifies every explicit formula; review includes the source of shared formulas and row inputs', () => {
  const index = engine.inspect(book, {sheet:null,includeFormulaRows:true}).sheets;
  assert.deepEqual(index.map(s => [s.formulaCellCount, s.formulaArea]), [[3,'C2:C4'],[1,'A1:A1']]);
  const rows = index[0].formulaRows.flat();
  assert.equal(rows.find(c => c.cell === 'A2').value, 1.5);
  assert.equal(rows.find(c => c.cell === 'C4').definition.expression, 'SUMPRODUCT(ROUND(C2:C3,2))');
  const query = {sheet:'Costs',range:'C3:C3',offset:0,where:null};
  const follower = engine.inspect(book,query).items[0].cells[0];
  assert.deepEqual(follower.definition.master,{cell:'C2',range:'C2:C3',expression:'A2*B2'});
  assert.equal(follower.definition.expression, undefined);
  assert.equal(follower.numberFormat, '0.00');
  assert.equal(index[1].formulaRows.flat()[0].value, null);
  assert.equal(engine.inspect(book, {sheet:null}).sheets[0].formulaRows, undefined);
});

test('larger reviews give exact coverage plus retrievable pages without claiming an inline sample', async () => {
  const wb = new ExcelJS.Workbook(), s = wb.addWorksheet('Many');
  for(let row=1;row<=250;row++) s.addRow([row,{formula:'A'+row+'*2',result:row*2}]);
  const large = engine.load(Buffer.from(await wb.xlsx.writeBuffer()));
  const index = engine.inspect(large, {sheet:null,includeFormulaRows:true}).sheets[0];
  assert.equal(index.formulaRows, undefined);
  assert.equal(index.formulaCellCount, 250);
  let offset=0, found=0;
  do {
    const part=engine.inspect(large,{sheet:'Many',range:'B1:B250',where:null,offset});
    for (const row of part.items) {
      assert.equal(row.cells[0].definition.expression, 'A'+row.row+'*2');
      found++;
    }
    offset=part.nextOffset;
  } while(offset!==null);
  assert.equal(found,250);
});

test('admission and provider use the same evidence for a review; other requests retain the normal index', async t => {
  const flags = ['COMPUTE_V2_ENABLED','PRIVATE_FILES_ENABLED','DOCUMENT_JOBS_ENABLED','OFFICE_INPUT_ENABLED','XLSX_EDIT_ENABLED','FILE_OUTPUT_ENABLED'];
  for(const flag of flags){
    const old=process.env[flag];process.env[flag]='true';
    t.after(()=>{if(old===undefined)delete process.env[flag];else process.env[flag]=old;});
  }
  const file={_id:'0123456789abcdef01234567',originalName:'Costs.xlsx',mimetype:office.TYPES.xlsx,size:bytes.length};
  t.mock.method(store,'owned',async()=>file);
  t.mock.method(store,'read',async()=>({file,buffer:bytes}));
  const attachments=[{fileId:file._id,storage:'private'}];
  const content='Проаналізуй всі формули та дай рекомендації';
  const model={};
  const state=textInput.budget();
  const output=await messages.providerContent('owner',content,attachments,{state,model});
  assert.match(output[1].text,/SUMPRODUCT/);
  const estimate=await context.estimate('owner',[{role:'user',content,attachments}],model,null);
  assert.deepEqual(estimate,state);
  const ordinary=await messages.providerContent('owner','Помнож стовпець A на 2',attachments,{model});
  assert.doesNotMatch(ordinary[1].text,/SUMPRODUCT/);
  const legacy=await office.extract(bytes,'xlsx');
  const records=legacy.split('\n').filter(l=>l.startsWith('{"cell"')).map(l=>JSON.parse(l));
  assert.ok(records.find(c=>c.cell==='C2').sharedIndex!=null);
  assert.equal(records.find(c=>c.cell==='C2').sharedIndex,records.find(c=>c.cell==='C3').sharedIndex);
  assert.equal(records.find(c=>c.cell==='C2').formulaRange,'C2:C3');
});
