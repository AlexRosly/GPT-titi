const test = require('node:test');
const assert = require('node:assert/strict');
const qa = require('../../src/services/docx/signatureQuality');
const sandbox = require('../../src/services/computation/session');
const continuation = require('../../src/services/docx/continuation');
const message = 'Подовж тільки лінії під усіма сімома підписантами на всю ширину рядка, включно з посадою та прізвищем.';
const sourceFileId = 'abc';
const source = {fileId:sourceFileId, storage:'private', originalName:'акт.docx'};
const plan = {profile:'signature-lines-v1', expected:7, sourceFileId};
const quality = {profile:plan.profile, signatures:7, pages:5, changedPages:2};
const state = () => ({kind:'document', pending:false, runs:2, lastActionFailed:false, usage:{promptTokens:1,completionTokens:2,totalTokens:3},
  files:[{fileId:'unrelated'}, {fileId:'result'}], docxCompletion:{version:1,run:2,sourceFileId,fileId:'result',quality}});

test('profile is opt-in and binds the explicit count and source at admission', t => {
  const old = process.env.DOCX_SIGNATURE_QA_ENABLED;
  t.after(() => { if (old === undefined) delete process.env.DOCX_SIGNATURE_QA_ENABLED; else process.env.DOCX_SIGNATURE_QA_ENABLED = old; });
  delete process.env.DOCX_SIGNATURE_QA_ENABLED;
  assert.equal(qa.plan(message,[source]),null);
  process.env.DOCX_SIGNATURE_QA_ENABLED = 'true';
  assert.deepEqual(qa.plan(message,[source]),plan);
  assert.equal(qa.plan(message.replace('сімома','12'),[source]).expected,12);
  assert.equal(qa.plan(message,[source,source]),null);
  assert.equal(qa.plan(message,[{...source,originalName:'data.xlsx'}]),null);
  assert.equal(qa.plan('Заміни прізвище у тексті',[source]),null);
});

test('protected completion and recovery publish only the checked file',() => {
  const turn = {docxQualityPlan:plan, computeState:state()};
  const result = continuation.completion(turn);
  assert.deepEqual(result.computation.files,[{fileId:'result'}]);
  assert.match(result.assistantText,/7 full-width signature lines/);
  assert.equal(result.usage.totalTokens,3);
  assert.equal(qa.publication({computeState:state()}),null);
});

test('provider assertions and unbound or partial markers do not promote any file',() => {
  for (const mutate of [
    t => { delete t.computeState.docxCompletion; },
    t => { t.computeState.docxCompletion.sourceFileId = 'different'; },
    t => { t.computeState.docxCompletion.fileId = 'missing'; },
    t => { t.computeState.runs++; },
    t => { t.computeState.docxCompletion.quality = {...quality,signatures:6}; },
    t => { t.responseState = {pending:true}; },
    t => { t.cancelRequestedAt = new Date(); },
    t => { t.providerResult.computation = {status:'partial',reason:'USER_CANCELLED'}; },
  ]) {
    const turn = {docxQualityPlan:plan, computeState:state(), providerResult:{assistantText:'All done', artifact:{},computation:{status:'completed',files:[{fileId:'other'}]}}};
    mutate(turn);
    assert.equal(continuation.completion(turn),null);
    const result = qa.publication(turn);
    assert.equal(result.computation.status,'partial');
    assert.deepEqual(result.computation.files,[]);
  }
});

test('renderer response must attest to the requested count and valid page totals',async t => {
  const mock = t.mock.method(sandbox,'runDocxQuality',async () => ({ok:true,text:JSON.stringify(quality)}));
  const execute = () => qa.verify(plan,Buffer.from('a'),Buffer.from('b'),undefined,1000);
  assert.deepEqual(await execute(),quality);
  for (const response of [{ok:true,text:'{}'}, {ok:false,text:'internal detail'},
    {ok:true,text:JSON.stringify({...quality,pages:0})},{ok:true,text:JSON.stringify({...quality,signatures:6})}]) {
    mock.mock.mockImplementation(async () => response);
    await assert.rejects(execute(),{fileError:'DOCX_QUALITY_RENDER'});
  }
});
