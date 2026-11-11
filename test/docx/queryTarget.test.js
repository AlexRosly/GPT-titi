const test=require('node:test'),assert=require('node:assert/strict');
const engine=require('../../src/services/docx/engine');
const policy=require('../../src/services/docx/policy');
const worker=require('../../src/services/docx/process');
const {fixture,table,p}=require('./fixtures');
const query=(patch={})=>({mode:'rows',start:0,end:null,contains:null,...patch});
const args=(target,q)=>({fileId:'012345678901234567890123',target,offset:0,query:q});

test('every advertised target accepts null, default query and summary without INVALID_QUERY_TARGET',async()=>{
 const doc=engine.load(await fixture(p('Introduction')+table));
 const schema=policy.tools[0].function.parameters;
 const validate=require('../../src/services/chatDeliveryV2/responsesTurn').validate;
 for(const target of ['tables','document','table0','p0','cell0']){
  const plain=engine.inspect(doc,target,0,null);
  for(const q of [null,query(),query({mode:'summary'})]){
   const a=args(target,q);assert.equal(validate(a,schema),true);
   assert.deepEqual(policy.parse('inspect_docx',JSON.stringify(a)),a);
   const r=engine.inspect(doc,target,0,q);
   assert.equal(r.checksum,doc.checksum);assert.equal(r.total,plain.total);
   if(q?.mode!=='summary')assert.deepEqual(r,plain);
   else assert.equal(r.coverage.sampled,true);
  }
 }
});

test('index ranges and literal filters apply to full source, with exact original item coordinates',async()=>{
 const body=Array.from({length:8},(_,i)=>table.replace('Посада',i===6?'x'.repeat(250)+' UNIQUE МІТКА':'Entry '+i)).join('');
 const doc=engine.load(await fixture(body));
 const found=engine.inspect(doc,'tables',0,query({contains:'мітка'}));
 assert.equal(found.sourceTotal,8);assert.equal(found.total,1);assert.equal(found.queryUnit,'items');
 assert.equal(found.items[0].id,'table6');assert.equal(found.items[0].sourceIndex,6);
 assert.equal(found.items[0].textTruncated,true);assert.doesNotMatch(found.items[0].text,/МІТКА/);
 assert.equal(found.selection,undefined,'an index must never become an edit selection');
 const range=engine.inspect(doc,'tables',0,query({start:2,end:5}));
 assert.deepEqual(range.items.map(i=>i.sourceIndex),[2,3,4]);
 const summary=engine.inspect(doc,'tables',0,query({mode:'summary'}));
 assert.deepEqual(summary.items.map(i=>i.sourceIndex),[0,1,7]);
 assert.equal(summary.coverage.complete,false);assert.equal(summary.coverage.matching,8);
 assert.equal(summary.nextOffset,null);
 const empty=engine.inspect(doc,'tables',0,query({contains:'not present'}));
 assert.equal(empty.total,0);assert.deepEqual(empty.items,[]);assert.equal(empty.coverage.complete,true);
});

test('document and paragraph queries retain source coordinates and exact text; cell alias preserves query',async()=>{
 const paragraph='<w:p><w:r><w:t>First</w:t></w:r><w:r><w:t>EXACT target</w:t></w:r><w:r><w:t>Last</w:t></w:r></w:p>';
 const doc=engine.load(await fixture(paragraph+table+p('Closing target')));
 const outline=engine.inspect(doc,'document',0,query({contains:'target'}));
 assert.equal(outline.sourceTotal,3);assert.deepEqual(outline.items.map(i=>i.sourceIndex),[0,2]);
 const text=engine.inspect(doc,'p0',0,query({start:1,end:2,contains:'target'}));
 assert.equal(text.sourceTotal,3);assert.deepEqual(text.items,[{sourceIndex:1,id:'text1',text:'EXACT target'}]);
 const cell=engine.inspect(doc,'cell0',0,query({contains:'absent'}));
 assert.equal(cell.total,0,'cell alias cannot silently drop the filter');
});

test('filtered index pagination is byte-bounded and visits every matching original item once',async()=>{
 const doc=engine.load(await fixture(Array.from({length:100},(_,i)=>p('Match '+i+' '+ '漢字'.repeat(100))).join('')));
 let offset=0;const seen=[];
 do{
  const r=engine.inspect(doc,'document',offset,query({start:5,end:95,contains:'match'}));
  assert.equal(r.total,90);assert.ok(Buffer.byteLength(JSON.stringify(r))<=14000);
  seen.push(...r.items.map(i=>i.sourceIndex));offset=r.nextOffset;
 }while(offset!==null);
 assert.deepEqual(seen,Array.from({length:90},(_,i)=>i+5));
});

test('production worker handles non-null index queries and rejects malformed predicates explicitly',async()=>{
 const buffer=await fixture(p('Heading')+table);
 for(const target of ['tables','document']){
  const r=await worker.run(buffer,'inspect_docx',args(target,query()),new AbortController().signal);
  assert.ok(r.inspection.items.length);assert.equal(r.inspection.queryUnit,'items');
 }
 for(const target of ['tables','document','table0','p0','cell0']){
  assert.throws(()=>policy.parse('inspect_docx',JSON.stringify(args(target,query({start:2,end:1})))),{fileError:'DOCUMENT_INVALID_QUERY'});
 }
 const doc=engine.load(buffer);
 assert.throws(()=>engine.inspect(doc,'tables',1,query({mode:'summary'})),{fileError:'DOCUMENT_INVALID_QUERY'});
 assert.throws(()=>policy.parse('inspect_docx',JSON.stringify(args('invented_target',query()))),{fileError:'DOCX_INVALID_ACTION'});
});
