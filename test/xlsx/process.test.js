const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./fixtures'),engine=require('../../src/services/xlsx/engine'),processXlsx=require('../../src/services/xlsx/process');
test('real parser worker persists chunks with backpressure, stops, and resumes a 5000-row file',async()=>{
 const input=await fixture(5000),book=engine.load(input),selection=engine.inspect(book,{sheet:'Дані',range:'A2:E5001',where:null,offset:0}).selection;
 const args={sourceChecksum:book.checksum,selectionId:selection.id,expectedRows:5000,operations:[{column:'B',type:'multiply',value:3}]};
 const records=[],controller=new AbortController();
 await assert.rejects(processXlsx.run(input,'chunks',args,{selection,signal:controller.signal,onChunk:async c=>{records.push(c);if(records.length===3)controller.abort(Object.assign(Error(),{fileError:'DOCUMENT_WORKER_CRASH'}));}}),{fileError:'DOCUMENT_WORKER_CRASH'});
 assert.equal(records.at(-1).processed,1500);
 await processXlsx.run(input,'chunks',args,{selection,cursor:1500,onChunk:async c=>{assert.equal(c.cursor,records.at(-1).processed);records.push(c);}});
 const output=await processXlsx.run(input,'assemble',args,{selection,records});assert.equal(output.report.changed,5000);assert.equal(output.report.chunks,10);
 const result=engine.load(Buffer.from(output.buffer)),sheet=engine.sheetData(result,'Дані'),row=sheet.rows[1500];
 assert.equal(engine.cells(result,sheet.xml.slice(row.start,row.end),row.r).get(2).value,(1500+.125)*3);
});
test('10000 rows × 20 columns exceed 5 MiB and remain a bounded preview and byte-bounded chunks',async()=>{
 const zip=await require('jszip').loadAsync(await fixture(1)),rows=[];
 for(let r=1;r<=10000;r++){
  const values=[];for(let c=0;c<20;c++)values.push(`<c r="${String.fromCharCode(65+c)}${r}" t="inlineStr"><is><t>${crypto.createHash('sha256').update(`${r}:${c}`).digest('hex')}</t></is></c>`);
  rows.push(`<row r="${r}">${values.join('')}</row>`);
 }
 zip.file('xl/worksheets/sheet1.xml',`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:T10000"/><sheetData>${rows.join('')}</sheetData></worksheet>`);
 const input=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});assert.ok(input.length>5*1024**2);assert.ok(input.length<20e6);
 const {inspection}=await processXlsx.run(input,'inspect',{sheet:'Дані',range:'A1:T10000',where:null,offset:0});
 assert.equal(inspection.coverage.matchingRows,10000);assert.ok(inspection.items.length<100);assert.ok(JSON.stringify(inspection).length<18000);
 const selection=inspection.selection,args={sourceChecksum:inspection.checksum,selectionId:selection.id,expectedRows:10000,operations:[{column:'T',type:'set_value',value:'edited'}]};
 let chunks=0,processed=0;await processXlsx.run(input,'chunks',args,{selection,onChunk:async c=>{assert.equal(c.cursor,processed);assert.ok(Buffer.byteLength(c.xml)<=1024**2);chunks++;processed=c.processed;}});
 assert.equal(processed,10000);assert.ok(chunks>20,'wide rows are split by bytes before the row cap');
 const controller=new AbortController();controller.abort();await assert.rejects(processXlsx.run(input,'inspect',{},{signal:controller.signal}),{name:'AbortError'});
});
test('external references and DTDs are refused before edits',async()=>{
 const input=await fixture(2),Zip=require('jszip');
 const external=await Zip.loadAsync(input);external.file('xl/_rels/evil.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="hyperlink" Target="https://example.invalid" TargetMode="External"/></Relationships>');
 await assert.rejects(processXlsx.run(await external.generateAsync({type:'nodebuffer'}),'inspect',{sheet:null,range:null,where:null,offset:0}),{fileError:'XLSX_UNSUPPORTED'});
 const dtd=await Zip.loadAsync(input);dtd.file('docProps/custom.xml','<!DOCTYPE x [<!ENTITY e SYSTEM "file:///private">]><x>&e;</x>');
 assert.throws(()=>engine.load(Buffer.alloc(0)),{fileError:'XLSX_FILE_LIMIT'});
 await assert.rejects(processXlsx.run(await dtd.generateAsync({type:'nodebuffer'}),'inspect',{}),{fileError:'XLSX_INVALID_DOCUMENT'});
});
