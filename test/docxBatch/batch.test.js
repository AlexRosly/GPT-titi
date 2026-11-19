const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),JSZip=require('jszip');
const runChild=require('./childHarness'),{fixture,oldText,newText}=require('./fixture');
const engine=require('../../src/services/docxBatch/engine'),adapters=require('../../src/services/documentJobs/adapters');
const policy=require('../../src/services/docxBatch/policy'),office=require('../../src/services/files/officeInput');
for(const pages of [5000,10000])test(pages+' pages: interrupt after third commit, recover in a new process, verify full package',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gptiti-docx-batch-'));
  const managed=process.env.DOCX_TEST_SUPERVISOR==='pm2'?require('./pm2Harness')('disk',dir):null;
  t.after(async()=>{try{if(managed)await managed.close();}finally{await fs.rm(dir,{recursive:true,force:true});}});
  const source=await fixture(pages);
  const {inspection}=await adapters.get('docx-text-v1').run(source,'inspect',{find:oldText},{});
  const selection=inspection.selection,plan={selectionId:selection.id,sourceChecksum:selection.sourceChecksum,expectedMatches:pages,value:newText};
  await fs.writeFile(path.join(dir,'source.docx'),source);
  await fs.writeFile(path.join(dir,'plan.json'),JSON.stringify({selection,plan}));
  assert.equal(await (managed?managed.first():runChild('disk','first',dir)),1500);
  const prefix=await fs.readFile(path.join(dir,'part-2.json'));
  if(managed)t.diagnostic(JSON.stringify(await managed.second()));else await runChild('disk','second',dir);
  assert.deepEqual(await fs.readFile(path.join(dir,'part-2.json')),prefix);
  const report=JSON.parse(await fs.readFile(path.join(dir,'report.json')));
  assert.equal(report.resumedFrom,1500);assert.equal(report.processedParagraphs,pages*3);
  assert.equal(report.changed,pages);assert.equal(report.chunks,Math.ceil(pages*3/500));
  const read=async buffer=>{
    const doc=await JSZip.loadAsync(buffer);
    const parts=new Map();
    for(const [name,entry] of Object.entries(doc.files))parts.set(name,await entry.async('nodebuffer'));
    return parts;
  };
  const a=await read(source),b=await read(await fs.readFile(path.join(dir,'result.docx')));
  assert.deepEqual([...a.keys()].sort(),[...b.keys()].sort());
  for(const [name,bytes] of a){
    const want=name==='word/document.xml'?Buffer.from(bytes.toString().replaceAll('>'+oldText+'<','>'+newText+'<')):bytes;
    assert.deepEqual(b.get(name),want);
  }
});
test('split-run match refuses the whole batch, and corrupt checkpoints cannot publish',async()=>{
  const source=await fixture(2),zip=await JSZip.loadAsync(source);
  const body=await zip.file('word/document.xml').async('string');
  zip.file('word/document.xml',body.replace(oldText,'Очікує </w:t></w:r><w:r><w:t>перевірки'));
  assert.throws(()=>engine.load(source.subarray(0,100),oldText));
  const split=await zip.generateAsync({type:'nodebuffer'});assert.throws(()=>engine.load(split,oldText),{fileError:'DOCX_BATCH_COMPLEX_MATCH'});
  const doc=engine.load(source,oldText),selection=engine.inspect(doc,oldText).selection;
  const plan={selectionId:selection.id,sourceChecksum:doc.checksum,expectedMatches:2,value:newText};
  const [record]=engine.chunks(doc,plan,selection,0);
  for(const payload of ['[]',record.xml.replace(newText,'Підмінено')]){
    await assert.rejects(engine.assemble(doc,plan,selection,[{...record,index:0,xml:payload,hash:engine.hash(payload)}]),{fileError:'DOCUMENT_CHECKPOINT_INVALID'});
  }
  await assert.rejects(engine.assemble(doc,plan,selection,[]),{fileError:'DOCUMENT_CHECKPOINT_INVALID'});
});
test('normal attachment reader reaches the batch adapter on a DOCX above 5 MiB and preserves media',async t=>{
  Object.assign(process.env,{PRIVATE_FILES_ENABLED:'true',DOCX_EDIT_ENABLED:'true',COMPUTE_V2_ENABLED:'true',DOCUMENT_JOBS_ENABLED:'true',DOCX_BATCH_ENABLED:'true'});
  const zip=await JSZip.loadAsync(await fixture(2));
  const payload=crypto.randomBytes(6*1024**2);
  zip.file('word/media/opaque.bin',payload,{createFolders:false});
  const source=await zip.generateAsync({type:'nodebuffer'});
  const file={_id:'source',size:source.length,originalName:'large.docx',mimetype:office.TYPES.docx};
  t.mock.method(require('../../src/services/files/store'),'read',async()=>({file,buffer:source}));
  const part=await office.readPart('user',file,{model:{}});
  assert.match(part.text,/STRUCTURED_DOCX_SOURCE/);
  const doc=engine.load(source,oldText),selection=engine.inspect(doc,oldText).selection;
  const plan={selectionId:selection.id,sourceChecksum:doc.checksum,expectedMatches:2,value:newText};
  const rows=[...engine.chunks(doc,plan,selection,0)].map((r,index)=>({...r,index,hash:engine.hash(r.xml)}));
  const result=await engine.assemble(doc,plan,selection,rows);
  assert.deepEqual(await (await JSZip.loadAsync(result.buffer)).file('word/media/opaque.bin').async('nodebuffer'),payload);
});
test('batch tool admission requires every feature flag and rejects malformed scopes',()=>{
  const computation=require('../../src/services/computation/policy');
  Object.assign(process.env,{PRIVATE_FILES_ENABLED:'true',COMPUTE_V2_ENABLED:'true',DOCX_EDIT_ENABLED:'true',DOCUMENT_JOBS_ENABLED:'true',DOCX_BATCH_ENABLED:'false'});
  assert.equal(computation.accepts(policy.inspectName,{}),false);
  process.env.DOCX_BATCH_ENABLED='true';
  assert.ok(computation.toolsFor({}).some(t=>t.function.name===policy.editName));
  assert.equal(computation.accepts(policy.editName,{fileOutputEnabled:false}),false);
  assert.throws(()=>policy.parse(policy.inspectName,JSON.stringify({fileId:'0'.repeat(24),find:'a',unsafe:true})),{fileError:'DOCX_BATCH_INVALID_ACTION'});
});

test('shared V2 executor saves inspected selection and hands the final edit to the durable queue',async t=>{
  Object.assign(process.env,{PRIVATE_FILES_ENABLED:'true',DOCX_EDIT_ENABLED:'true',COMPUTE_V2_ENABLED:'true',DOCUMENT_JOBS_ENABLED:'true',DOCX_BATCH_ENABLED:'true'});
  const store=require('../../src/services/files/store'),{ChatTurn}=require('../../src/models');
  const queue=require('../../src/services/documentJobs/queue'),execute=require('../../src/services/computation/execute');
  const source=await fixture(4),fileId='abcd'.repeat(6),checksum=engine.hash(source);
  const file={originalName:'source.docx',size:source.length,checksum};
  const turn={_id:'turn',user:'owner',turnId:'id',attempt:1,computeState:{runs:0,calls:0,pending:false,executionMs:0,files:[],usage:{promptTokens:1,completionTokens:1,totalTokens:2}}};
  t.mock.method(store,'read',async(u,id)=>{assert.equal(id,fileId);assert.equal(u,'owner');return {file,buffer:source};});
  t.mock.method(store,'owned',async()=>file);
  t.mock.method(store,'transaction',fn=>fn({}));
  t.mock.method(ChatTurn,'findOne',()=>({session:async()=>turn}));
  t.mock.method(ChatTurn,'updateOne',async()=>({matchedCount:1}));
  let handed=0;
  t.mock.method(queue,'enqueue',async({adapter,selection,token})=>{
    assert.equal(adapter,'docx-text-v1');assert.equal(token,'lease');assert.equal(selection.matched,4);
    handed++;return {deferred:true,jobId:'new-job'};
  });
  const run=(name,args)=>execute.run({turn,token:'lease',model:{},available:[{fileId}],completionAllowed:true,
    call:{function:{name,arguments:JSON.stringify(args)}},initialUsage:turn.computeState.usage,save:async state=>{turn.computeState=state;}});
  const read=await run(policy.inspectName,{fileId,find:oldText});
  assert.equal(read.result.ok,true);
  const selection=Object.values(turn.computeState.docxBatchSelections)[0];
  const args={fileId,sourceChecksum:checksum,selectionId:selection.id,expectedMatches:4,value:newText,filename:'copy.docx'};
  const stale=await run(policy.editName,{...args,sourceChecksum:'0'.repeat(64)});
  assert.equal(stale.result.text,'DOCX_BATCH_SELECTION_MISMATCH');assert.equal(handed,0);
  assert.deepEqual(await run(policy.editName,args),{deferred:true,jobId:'new-job'});assert.equal(handed,1);
  turn.docxQualityPlan={profile:'table-cell-text-v1'};
  await assert.rejects(run(policy.editName,args),{fileError:'DOCX_QUALITY_UNVERIFIED'});
});
