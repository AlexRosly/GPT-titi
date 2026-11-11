const test=require('node:test'),assert=require('node:assert/strict');
const engine=require('../../src/services/xlsx/engine'),policy=require('../../src/services/xlsx/policy');
const {fixture}=require('./fixtures');
let input,book;
test.before(async()=>{input=await fixture();book=engine.load(input);});
function plan(selection,operations=[{column:'B',type:'multiply',value:2,expected:null}]){return {fileId:'0123456789abcdef01234567',sourceChecksum:book.checksum,filename:'edited.xlsx',selectionId:selection.id,expectedRows:selection.matchingRows,operations};}
const inspect=extra=>engine.inspect(book,{sheet:'Дані',range:'A2:E10001',where:null,offset:0,...extra});
const records=chunks=>chunks.map(c=>({...c,hash:engine.hash(c.xml)}));
test('10000-row inspection aggregates the full source while bounding model context',()=>{
 const v=inspect();assert.equal(v.selection.matchingRows,10000);assert.equal(v.coverage.scannedRows,10000);
 assert.ok(v.items.length<10000);assert.ok(v.nextOffset>0);assert.ok(Buffer.byteLength(JSON.stringify(v))<18000);
 const b=v.statistics.find(s=>s.column==='B');assert.equal(b.sum,50006250);assert.equal(b.numericCount,10000);
 assert.equal(v.statistics.find(s=>s.column==='D').formulaCells,10000);
 const later=inspect({where:{column:'C',operator:'equals',value:'LAST'}});assert.equal(later.items[0].row,10001);assert.equal(later.selection.matchingRows,1);
 const next=inspect({offset:v.nextOffset});assert.equal(next.items[0].row,v.nextOffset+2);assert.equal(next.selection.id,v.selection.id);
});
test('chunked 10000-row edit resumes from checkpoint without applying multiplication twice',async()=>{
 const selection=inspect().selection,args=plan(selection),first=records([...engine.chunks(book,args,selection)]);
 assert.equal(first.length,20);assert.equal(first[0].processed,500);assert.equal(first.at(-1).processed,10000);
 const recovered=first.slice(0,7).concat(records([...engine.chunks(engine.load(input),args,selection,3500)]));
 const output=await engine.assemble(book,args,selection,recovered);
 assert.equal(output.report.changed,10000);assert.equal(output.report.matched,10000);assert.equal(output.report.otherPartsByteIdentical,true);
 const result=engine.load(output.buffer),before=engine.sheetData(book,'Дані'),after=engine.sheetData(result,'Дані');
 for(const i of [1,3500,3501,10000]){
  const row=after.rows[i],values=engine.cells(result,after.xml.slice(row.start,row.end),row.r);assert.equal(values.get(2).value,(i+0.125)*2);
  const source=before.rows[i],old=engine.cells(book,before.xml.slice(source.start,source.end),source.r);assert.equal(values.get(4).formula,true);assert.equal(values.get(4).value,old.get(4).value);
 }
 for(const [name,bytes]of book.parts)if(!['xl/worksheets/sheet1.xml','xl/workbook.xml'].includes(name))assert.deepEqual(result.parts.get(name),bytes,name);
 const wb=new(require('exceljs').Workbook)();await wb.xlsx.load(output.buffer);assert.equal(wb.getWorksheet('Дані').getCell('B2').font.bold,true);
 assert.equal(wb.getWorksheet('Keep').getCell('A1').value,'Не змінювати');
});
test('formula protection and literal strings cannot inject executable formulas',async()=>{
 const selection=inspect({range:'A2:E2'}).selection,args=plan(selection,[{column:'D',type:'set_value',value:99,expected:null},{column:'E',type:'set_value',value:'=HYPERLINK("https://example.invalid")',expected:null}]);
 const output=await engine.assemble(book,args,selection,records([...engine.chunks(book,args,selection)]));
 assert.equal(output.report.formulaSkipped,1);assert.equal(output.report.changed,1);
 const wb=new(require('exceljs').Workbook)();await wb.xlsx.load(output.buffer);assert.equal(wb.getWorksheet('Дані').getCell('E2').value,args.operations[1].value);assert.ok(wb.getWorksheet('Дані').getCell('D2').value.formula);
});
test('stale checksums, mismatched counts and corrupt or missing checkpoints fail atomically',async()=>{
 const selection=inspect({range:'A2:E1001'}).selection,args=plan(selection),all=records([...engine.chunks(book,args,selection)]);
 assert.throws(()=>engine.prepare(book,{...args,sourceChecksum:'0'.repeat(64)},selection),{fileError:'XLSX_SOURCE_CHANGED'});
 assert.throws(()=>engine.prepare(book,{...args,expectedRows:1},selection),{fileError:'XLSX_SELECTION_MISMATCH'});
 await assert.rejects(engine.assemble(book,args,selection,all.slice(1)),{fileError:'DOCUMENT_CHECKPOINT_INVALID'});
 await assert.rejects(engine.assemble(book,args,selection,[{...all[0],xml:all[0].xml+'corrupt'},...all.slice(1)]),{fileError:'DOCUMENT_CHECKPOINT_INVALID'});
});
test('strict policy rejects unbounded operations and invalid A1 coordinates',()=>{
 assert.equal(policy.column('XFD'),16384);assert.throws(()=>policy.column('XFE'));
 assert.throws(()=>policy.range('A1:A1048577'));assert.throws(()=>policy.range('D2:A1'));
 const sel=inspect({range:'A2:E2'}).selection,args=plan(sel);
 assert.deepEqual(policy.parse('edit_xlsx',JSON.stringify(args)),args);
 assert.throws(()=>policy.parse('edit_xlsx',JSON.stringify({...args,operations:[...args.operations,...args.operations]})),{fileError:'XLSX_INVALID_ACTION'});
 assert.throws(()=>policy.parse('inspect_xlsx',JSON.stringify({fileId:args.fileId,sheet:'Дані',range:null,where:{column:'B',operator:'gt',value:'bad'},offset:0})),{fileError:'XLSX_INVALID_ACTION'});
});


test('decimal rounding, missing cells, literals with OOXML escapes, and sparse rows are preserved correctly',async()=>{
 const wb=new(require('exceljs').Workbook)(),s=wb.addWorksheet('Data');
 s.addRow([1,1.005,'_x0041_']);s.addRow([2,-2.675,'line']);s.getCell('A5').value=5;
 const zip=await require('jszip').loadAsync(await wb.xlsx.writeBuffer());
 zip.file('xl/sharedStrings.xml',(await zip.file('xl/sharedStrings.xml').async('string')).replace('_x0041_','_x005F_x0041_'));
 const source=engine.load(await zip.generateAsync({type:'nodebuffer'}));
 const v=engine.inspect(source,{sheet:'Data',range:'A1:E5',where:null,offset:0});assert.equal(v.selection.matchingRows,3);assert.equal(v.items[0].cells[2].value,'_x0041_');
 const args={sourceChecksum:source.checksum,selectionId:v.selection.id,expectedRows:3,operations:[{column:'B',type:'round',value:2},{column:'D',type:'set_value',value:'_x000A_'},{column:'E',type:'set_value',value:'=1+1'}]};
 const out=await engine.assemble(source,args,v.selection,records([...engine.chunks(source,args,v.selection)]));
 const result=new(require('exceljs').Workbook)();await result.xlsx.load(out.buffer);const sheet=result.getWorksheet('Data');
 assert.equal(sheet.getCell('B1').value,1.01);assert.equal(sheet.getCell('B2').value,-2.68);assert.equal(sheet.getCell('B5').value,null);
 const reopened=engine.load(out.buffer),data=engine.sheetData(reopened,'Data'),first=data.rows[0];
 assert.equal(engine.cells(reopened,data.xml.slice(first.start,first.end),first.r).get(4).value,'_x000A_');
 assert.match(data.xml,/_x005F_x000A_/);assert.equal(sheet.getCell('E5').value,'=1+1');assert.equal(out.report.nonNumericSkipped,1);
});

test('merged non-anchor cells are refused and array formula ranges are protected',async()=>{
 const wb=new(require('exceljs').Workbook)(),s=wb.addWorksheet('Data');s.addRow([1,2]);s.addRow([3,4]);s.mergeCells('A1:A2');
 const source=engine.load(Buffer.from(await wb.xlsx.writeBuffer())),v=engine.inspect(source,{sheet:'Data',range:'A1:B2',where:null,offset:0});
 assert.throws(()=>engine.prepare(source,{sourceChecksum:source.checksum,selectionId:v.selection.id,expectedRows:2,operations:[{column:'A',type:'set_value',value:9}]},v.selection),{fileError:'XLSX_MERGED_TARGET'});
 const zip=await require('jszip').loadAsync(await require('./fixtures').fixture(2));let xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
 xml=xml.replace('<f>B2*2</f>','<f t="array" ref="D2:D3">B2:B3*2</f>').replace('<f>B3*2</f>','');zip.file('xl/worksheets/sheet1.xml',xml);
 const b=engine.load(await zip.generateAsync({type:'nodebuffer'})),v2=engine.inspect(b,{sheet:'Дані',range:'A2:E3',where:null,offset:0});
 const args={sourceChecksum:b.checksum,selectionId:v2.selection.id,expectedRows:2,operations:[{column:'D',type:'set_value',value:8}]};
 const out=await engine.assemble(b,args,v2.selection,records([...engine.chunks(b,args,v2.selection)]));assert.equal(out.report.formulaSkipped,2);assert.equal(out.report.changed,0);
});
