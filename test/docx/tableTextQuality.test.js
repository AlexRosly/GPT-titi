const test = require('node:test');
const assert = require('node:assert/strict');
const {source, cell, plan, prompt} = require('../../scripts/docxTableTextSmoke');
const qa = require('../../src/services/docx/signatureQuality');
const table = require('../../src/services/docx/tableText');
const engine = require('../../src/services/docx/engine');
const sandbox = require('../../src/services/computation/session');
const continuation = require('../../src/services/docx/continuation');
const file = {storage:'private',originalName:'source.docx',fileId:'012345678901234567890123'};
const report = {profile:table.profile,pages:1,changedPages:1,changedCells:1};
const accepted = {ok:true,text:JSON.stringify(report)};
const rejected = reason => ({ok:false,text:'DOCX_QUALITY_'+reason});

test('binds the literal selector, filename and one original only for a supported full request', () => {
  process.env.DOCX_SIGNATURE_QA_ENABLED = 'false';
  process.env.DOCX_TABLE_TEXT_QA_ENABLED = 'false';
  assert.equal(qa.plan(prompt,[file]),null);
  process.env.DOCX_TABLE_TEXT_QA_ENABLED = 'true';
  assert.deepEqual(qa.plan(prompt,[file]),{...plan,sourceFileId:file.fileId,filename:'QA_DOCX_table_result.docx'});
  const different = prompt.replace('Реєстр заявок','Доручення').replace('QA-102','АБ-8')
    .replace('Статус','Група').replace('Чернетка','Сектор 1').replace('Прийнято','Сектор 2');
  assert.deepEqual(qa.plan(different,[file]).cell,
    {title:'Доручення',code:'АБ-8',column:'Група',oldText:'Сектор 1',newText:'Сектор 2'});
  assert.equal(qa.plan(prompt+' Також зміни заголовок.',[file]),null);
  assert.equal(qa.plan(prompt,[file,file]),null);
  assert.equal(qa.plan(prompt,[{...file,storage:'public'}]),null);
});

test('missing, stale and non-unique selectors never choose a fallback cell', () => {
  const doc = engine.load(source);
  for (const [changes,reason] of [[{title:'wrong'},'UNSUPPORTED'],[{code:'unknown'},'COVERAGE'],
    [{column:'missing'},'UNSUPPORTED'],[{oldText:'stale'},'COVERAGE']]) {
    assert.throws(() => table.operation(doc,{...cell,...changes}),{fileError:'DOCX_QUALITY_'+reason});
  }
  const body = doc.root.children.find(n => n.local === 'body');
  const tbl = body.children.find(n => n.local === 'tbl');
  const rows = tbl.children.filter(n => n.local === 'tr');
  tbl.children.push(rows[2]);
  assert.throws(() => table.operation(doc,cell),{fileError:'DOCX_QUALITY_COVERAGE'});
  tbl.children.pop();
  body.children.push(body.children[0],tbl);
  assert.throws(() => table.operation(doc,cell),{fileError:'DOCX_QUALITY_UNSUPPORTED'});
});

test('actual action binds edited copy name and recovers one invalid candidate from the original', async t => {
  process.env.PRIVATE_FILES_ENABLED='true';
  process.env.COMPUTE_V2_ENABLED='true';
  process.env.DOCX_EDIT_ENABLED='true';
  const store = require('../../src/services/files/store');
  t.mock.method(store,'owned',async () => ({originalName:file.originalName,size:source.length}));
  t.mock.method(store,'read',async () => ({buffer:source}));
  const doc = engine.load(source);
  const first = table.operation(doc,{...cell,code:'QA-101'});
  const target = table.operation(doc,cell);
  let calls = 0;
  t.mock.method(sandbox,'runDocxQuality',async request => {
    assert.equal(request.profile,table.profile);
    assert.deepEqual(request.cell,cell);
    assert.deepEqual(Buffer.from(request.source,'base64'),source);
    const candidate = engine.load(Buffer.from(request.result,'base64'));
    calls++;
    assert.equal(candidate.byId.get(first.target).text,calls===1?cell.newText:cell.oldText);
    assert.equal(candidate.byId.get(target.target).text,calls===1?cell.oldText:cell.newText);
    return calls===1 ? rejected('CELL_MISMATCH') : accepted;
  });
  const args = {fileId:file.fileId,sourceChecksum:doc.checksum,filename:'model-choice.docx',operations:[first],complete:true};
  const turn = {user:'owner',docxQualityPlan:{...plan,sourceFileId:file.fileId,filename:'requested.docx'},
    computeState:{docxInspections:{[file.fileId]:doc.checksum}}};
  const action = require('../../src/services/docx/action');
  const run = args => action.run({model:{},turn,completionAllowed:true,available:[file],
    call:{function:{name:'edit_docx',arguments:JSON.stringify(args)}}});
  await assert.rejects(run({...args,repairCell:cell}),{fileError:'DOCX_INVALID_ACTION'});
  await assert.rejects(run({...args,complete:false}),{fileError:'DOCX_FINAL_EDIT_REQUIRED'});
  const result = await run(args);
  assert.equal(result.completed,true);
  assert.equal(result.prepared.length,1);
  assert.equal(result.prepared[0].name,'requested.docx');
  assert.deepEqual(result.prepared[0].documentEdit.tableTextQuality,{...report,repairAttempts:1});
  assert.equal(calls,2);
});

test('repair is bounded and errors in rendering, layout, source selection and cancellation terminate',async t => {
  const verify = t.mock.method(sandbox,'runDocxQuality');
  for (const [reason, attempts] of [['CELL_MISMATCH',2],['LAYOUT',1],['RENDER',1],['TIMEOUT',1],
    ['COVERAGE',1],['UNSUPPORTED',1]]) {
    let calls=0;
    verify.mock.mockImplementation(async () => rejected(reason));
    const run = async () => {calls++;return {buffer:source,report:{}};};
    await assert.rejects(table.editVerified(plan,{},source,run,()=>5000),{fileError:'DOCX_QUALITY_'+reason});
    assert.equal(calls,attempts);
  }
  const stop = new AbortController();
  let calls=0;
  verify.mock.mockImplementation(async () => {stop.abort();return rejected('CELL_MISMATCH');});
  await assert.rejects(table.editVerified(plan,{},source,async () => {calls++;return {buffer:source,report:{}};},
    ()=>5000,stop.signal),{name:'AbortError'});
  assert.equal(calls,1);
});

test('file verification must match the checkpoint from this run', () => {
  const saved={...report,repairAttempts:1};
  assert.ok(table.matchesCheckpoint({...saved},saved));
  for (const patch of [{pages:2},{changedCells:0},{repairAttempts:0},{profile:'signature-lines-v1'}]) {
    assert.equal(table.matchesCheckpoint({...saved,...patch},saved),false);
  }
});

test('recovery publishes only a checked, completed single-cell result',() => {
  const turn={docxQualityPlan:plan, computeState:{runs:2,pending:false,kind:'document',
    usage:{promptTokens:1,completionTokens:1,totalTokens:2},files:[{fileId:'out'}],
    docxCompletion:{version:1,run:2,sourceFileId:plan.sourceFileId,fileId:'out',quality:{...report,repairAttempts:0}}}};
  assert.deepEqual(continuation.completion(turn).computation.files,[{fileId:'out'}]);
  for(const q of [{...report,pages:41},{...report,changedCells:2},{...report,profile:'signature-lines-v1'}]){
    turn.computeState.docxCompletion.quality=q;
    assert.equal(continuation.completion(turn),null);
    assert.deepEqual(qa.publication(turn).computation.files,[]);
  }
});
