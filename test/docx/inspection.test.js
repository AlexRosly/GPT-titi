const test = require('node:test'), assert = require('node:assert/strict');
const inspect = require('../../src/services/documents/inspection');
const engine = require('../../src/services/docx/engine');
const policy = require('../../src/services/docx/policy');
const {fixture, table, p, border} = require('./fixtures');
const q = (patch = {}) => ({mode:'rows',start:0,end:null,contains:null,...patch});
const row = (text) => `<w:tr><w:tc>${p(text)}</w:tc></w:tr>`;
const selectBorder = (s, patch = {}) => ({type:'selection_border',selectionId:s.id,
  expectedCells:s.cellCount,side:'bottom',style:'single',size:4,color:'auto',...patch});

test('format-independent scan finds late rows in 5000, independent of displayed sample', () => {
  const rows = Array.from({length:5000}, (_,index) => ({index,text:index===4999?'Ціль TARGET':'Other'}));
  assert.deepEqual(inspect.select(rows,q({contains:'target'})).map(r=>r.index),[4999]);
  assert.equal(inspect.select(rows,q({start:2000,end:4000})).length,2000);
  const sample = inspect.present({base:{},items:rows,render:r=>r,summary:true});
  assert.equal(sample.total,5000); assert.equal(sample.items.length,3);
  assert.equal(sample.items.at(-1).index,4999); assert.equal(sample.coverage.complete,false);
  assert.equal(sample.coverage.sampled,true); assert.equal(sample.nextOffset,null);
});

test('byte pagination includes exact Unicode/JSON overhead and never silently skips an item', () => {
  const items = Array.from({length:500},(_,index)=>({index,text:'漢字\\"\n'.repeat(20)}));
  let offset=0, seen=[];
  do {
    const r=inspect.present({base:{},items,offset,render:x=>x});
    assert.ok(Buffer.byteLength(JSON.stringify(r))<=inspect.MAX_BYTES);
    assert.equal(r.coverage.complete,false);seen.push(...r.items.map(i=>i.index));offset=r.nextOffset;
  } while(offset!==null);
  assert.deepEqual(seen,items.map(i=>i.index));
  assert.throws(()=>inspect.present({base:{},items:[{text:'x'.repeat(15000)}],render:x=>x}),{fileError:'DOCX_INSPECTION_LIMIT'});
});

test('25 DOCX rows fit one response within unchanged byte bound', async () => {
  const doc=engine.load(await fixture(`<w:tbl>${Array.from({length:25},(_,i)=>row('Row '+i)).join('')}</w:tbl>`));
  const r=engine.inspect(doc,'table0',0);
  assert.equal(r.items.length,25);assert.equal(r.nextOffset,null);assert.equal(r.coverage.complete,true);
  assert.equal(r.selection.cellCount,25);assert.ok(Buffer.byteLength(JSON.stringify(r))<=14000);
});

test('range, full-source literal filter, preview and stable selection share source coordinates', async () => {
  const doc=engine.load(await fixture(`<w:tbl>${Array.from({length:150},(_,i)=>row(i===149?'TARGET':'Row '+i)).join('')}</w:tbl>`));
  const found=engine.inspect(doc,'table0',0,q({contains:'target'}));
  assert.equal(found.items[0].row,149);assert.equal(found.selection.cellCount,1);
  const full=engine.inspect(doc,'table0',0), summary=engine.inspect(doc,'table0',0,q({mode:'summary'}));
  assert.equal(full.selection.id,summary.selection.id);assert.equal(summary.total,150);
  assert.equal(summary.coverage.complete,false);assert.equal(summary.items.at(-1).row,149);
  const r=engine.inspect(doc,'table0',0,q({start:100,end:105}));
  assert.deepEqual(r.items.map(i=>i.row),[100,101,102,103,104]);
  const result=await engine.edit(doc,[selectBorder(r.selection)],{[r.selection.id]:r.selection});
  const edited=engine.load(result.buffer);
  assert.equal(result.report.expandedOperationCount,5);
  assert.equal((edited.xml.match(/<w:bottom /g)||[]).length,5);
  for(const n of doc.byId.values())if(n.local==='t')assert.equal(edited.byId.get(n.id).text,n.text);
  assert.equal(edited.xml.includes('<w:tc><w:p><w:r><w:t>Row 99'),true);
});

test('unobserved, stale, mismatched, duplicated and nested overlapping selections fail atomically', async () => {
  const doc=engine.load(await fixture(table)),s=engine.inspect(doc,'table0',0).selection,op=selectBorder(s);
  await assert.rejects(engine.edit(doc,[op]),{fileError:'DOCX_SELECTION_REQUIRED'});
  await assert.rejects(engine.edit(doc,[op],{[s.id]:{...s,sourceChecksum:'a'.repeat(64)}}),{fileError:'DOCX_SELECTION_REQUIRED'});
  await assert.rejects(engine.edit(doc,[selectBorder(s,{expectedCells:1})],{[s.id]:s}),{fileError:'DOCX_SELECTION_MISMATCH'});
  await assert.rejects(engine.edit(doc,[op,border('cell0')],{[s.id]:s}),{fileError:'DOCX_DUPLICATE_OPERATION'});
  const nested=engine.load(await fixture(`<w:tbl><w:tr><w:tc>${p('Outer')}${table}</w:tc></w:tr></w:tbl>`));
  const n=engine.inspect(nested,'table0,table1',0).selection;
  await assert.rejects(engine.edit(nested,[selectBorder(n)],{[n.id]:n}),{fileError:'DOCX_OVERLAPPING_OPERATIONS'});
});

test('query and selection action validation reject malformed/unbounded executable input', () => {
  for(const query of [q({contains:''}),q({contains:'x'.repeat(257)}),q({start:-1}),q({end:0}),q({mode:'eval'}),{...q(),script:'x'}])assert.throws(()=>inspect.normalize(query));
  const good={fileId:'012345678901234567890123',sourceChecksum:'a'.repeat(64),filename:'new.docx',complete:true,
    operations:[selectBorder({id:'b'.repeat(64),cellCount:5000})]};
  assert.equal(policy.parse('edit_docx',JSON.stringify(good)).operations[0].expectedCells,5000);
  for(const patch of [{expectedCells:0},{expectedCells:10001},{selectionId:'bad'},{color:'"/>'}])assert.throws(()=>policy.parse('edit_docx',JSON.stringify({...good,operations:[{...good.operations[0],...patch}]})));
});

test('a 5000-row DOCX is selected and edited in one local batch, with exact source/other-parts preservation', async () => {
  const buffer=await fixture(`<w:tbl>${Array.from({length:5000},(_,i)=>row('Record '+i)).join('')}</w:tbl>`);
  const worker=require('../../src/services/docx/process');
  const doc=engine.load(buffer), {inspection:r}=await worker.run(buffer,'inspect_docx',{target:'table0',offset:0,query:q({mode:'summary'})},new AbortController().signal);
  assert.equal(r.selection.cellCount,5000);assert.equal(r.items.length,3);
  const result=await worker.run(buffer,'edit_docx',{sourceChecksum:doc.checksum,operations:[selectBorder(r.selection)],selections:{[r.selection.id]:r.selection}},new AbortController().signal);
  result.buffer=Buffer.from(result.buffer);
  assert.equal(result.report.operations.length,1);assert.equal(result.report.expandedOperationCount,5000);
  const output=engine.load(result.buffer);
  assert.equal((output.xml.match(/<w:bottom /g)||[]).length,5000);
  assert.equal(output.byId.get('text4999').text,'Record 4999');
  assert.equal(output.xml.replaceAll('<w:tcPr><w:tcBorders><w:bottom w:val="single" w:sz="4" w:color="auto"></w:bottom></w:tcBorders></w:tcPr>',''),doc.xml);
  for(const [name,bytes]of doc.parts)if(name!=='word/document.xml')assert.deepEqual(output.parts.get(name),bytes);
  assert.equal(engine.hash(buffer),doc.checksum);
});
