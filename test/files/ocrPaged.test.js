const test=require('node:test'), assert=require('node:assert/strict');
const paged=require('../../src/services/files/ocrPaged');
const store=require('../../src/services/files/store');
const engine=require('../../src/services/files/ocrProcess');
const File=require('../../src/models/managedFile'),Quota=require('../../src/models/fileQuota');
const page=n=>({text:`prefix\n[PDF PAGE ${n} OF 3 — OCR]\nPAGE ${n} 137,50\n`,pages:1,detections:[{page:n,models:['eng']}]});
function fixture(t){
 const f={_id:'0123456789abcdef01234567',checksum:'abc',size:3,derivedBytes:0,status:'ready'};
 t.mock.method(store,'read',async()=>({file:f,buffer:Buffer.from('pdf')}));
 t.mock.method(store,'owned',async()=>f);
 t.mock.method(store,'transaction',async fn=>fn({}));
 t.mock.method(engine,'languages',()=> 'eng');
 let quota=0;
 t.mock.method(Quota,'updateOne',async(q,u)=>{quota+=u.$inc.bytes;return {matchedCount:1}});
 t.mock.method(File,'updateOne',async(q,u)=>{Object.assign(f,JSON.parse(JSON.stringify(u.$set)));return {matchedCount:1}});
 return {f,quota:()=>quota};
}
test('page checkpoints resume after interruption and finalize without double quota',async t=>{
 const {f,quota}=fixture(t); const calls=[];
 const recognition=t.mock.method(engine,'extract',async(b,k,o)=>{calls.push(o.page);if(o.page==='inspect')return {totalPages:3,manifest:[1,2,3].map(page=>({page,ocr:true}))};if(o.page===2)throw Object.assign(new Error(),{fileError:'PREPARATION_INTERRUPTED'});return page(o.page)});
 await assert.rejects(paged.prepare('u',f._id,{beforeCommit:async()=>{}}),{fileError:'PREPARATION_INTERRUPTED'});
 assert.equal(f.ocrProgress.completed.length,1);assert.equal(f.ocrCache,undefined);assert.equal(quota(),f.derivedBytes);
 recognition.mock.mockImplementation(async(b,k,o)=>{assert.notEqual(o.page,1);assert.notEqual(o.page,'inspect');return page(o.page)});
 await paged.prepare('u',f._id,{beforeCommit:async()=>{}});
 assert.equal(f.ocrProgress,null);assert.equal(f.ocrCache.totalPages,3);assert.equal(quota(),f.derivedBytes);
 assert.ok(f.ocrCache.text.indexOf('PAGE 1')<f.ocrCache.text.indexOf('PAGE 2'));
});
test('lost lease cannot persist checkpoints',async t=>{
 const {f,quota}=fixture(t);
 t.mock.method(engine,'extract',async()=>({totalPages:1,manifest:[{page:1,ocr:true}]}));
 await assert.rejects(paged.prepare('u',f._id,{beforeCommit:async()=>{throw Object.assign(new Error(),{fileError:'PREPARATION_INTERRUPTED'})}}),{fileError:'PREPARATION_INTERRUPTED'});
 assert.equal(quota(),0);assert.equal(f.ocrProgress,undefined);
});
test('temporary page errors get three bounded attempts; completed pages persist',async t=>{
 const {f}=fixture(t);let runs=0;
 t.mock.method(engine,'extract',async(b,k,o)=>{if(o.page==='inspect')return {totalPages:3,manifest:[1,2,3].map(page=>({page,ocr:true}))};if(o.page===1)return page(1);runs++;throw Object.assign(new Error(),{fileError:'OCR_FAILED'})});
 await assert.rejects(paged.prepare('u',f._id,{beforeCommit:async()=>{}}),{fileError:'OCR_FAILED'});
 assert.equal(runs,3);assert.equal(f.ocrProgress.completed.length,1);assert.equal(f.ocrProgress.failedPage,2);
});
test('real PDF inspection accepts 30 OCR pages, rejects 31, extracts an explicit physical page',async()=>{
 process.env.OCR_LANGUAGES='eng';const {makeScan}=require('./fixtures/ocr');
 const bytes=await makeScan(Array.from({length:30},(_,i)=>'INVOICE '+(i+1)));
 const manifest=await engine.extract(bytes,'pdf',{page:'inspect'});assert.equal(manifest.totalPages,30);
 const result=await engine.extract(bytes,'pdf',{page:12});assert.match(result.text,/PDF PAGE 12 OF 30/);assert.match(result.text,/INVOICE 12/);assert.equal(result.detections[0].page,12);
 const tooMany=await makeScan(Array(31).fill('INVOICE'));
 await assert.rejects(engine.extract(tooMany,'pdf',{page:'inspect'}),{fileError:'OCR_PAGE_LIMIT'});
});
test('paged inspection distinguishes 100 physical pages from the 30 OCR-page ceiling',async()=>{
 const {makeScan}=require('./fixtures/ocr');
 const hundred=await makeScan(Array.from({length:100},(_,i)=>({text:'TEXT '+i})));
 const manifest=await engine.extract(hundred,'pdf',{page:'inspect'});
 assert.equal(manifest.totalPages,100);assert.equal(manifest.manifest.filter(p=>p.ocr).length,0);
 const tooMany=await makeScan(Array.from({length:101},()=>({text:'TEXT'})));
 await assert.rejects(engine.extract(tooMany,'pdf',{page:'inspect'}),{fileError:'PDF_PAGE_LIMIT'});
 await assert.rejects(engine.extract(Buffer.alloc(25000001),'pdf',{page:'inspect'}),{fileError:'OCR_FILE_TOO_LARGE'});
});
