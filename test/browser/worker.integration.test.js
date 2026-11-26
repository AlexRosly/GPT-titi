const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
process.env.OPENAI_API_KEY ||= 'web-integration-no-real-api';
process.env.OCR_ENABLED = 'false';
process.env.PRIVATE_FILES_ENABLED = 'true';
const mongoose = require('mongoose');
const models = require('../../src/models');
const worker = require('../../src/services/chatDeliveryV2/worker');
const accept = require('../../src/services/chatDeliveryV2/acceptTurn');
const retry = require('../../src/services/chatDeliveryV2/retryTurn');
const reader = require('../../src/services/web/fetch');
const { fail } = require('../../src/services/web/policy');
const reservation = require('../../src/services/web/reservation');
const { snapshot } = require('../../src/services/chatDeliveryV2/snapshot');
const { Completions } = require('openai/resources/chat/completions');
const uri = process.env.FILES_TEST_MONGO_URI;
const opts = { skip: !uri };
const usage = { prompt_tokens:100, completion_tokens:20, total_tokens:120 };
const page = url => ({url,title:'Multilingual article',text:'Український текст. 日本語 العربية. '.repeat(20),truncated:false,fetchedAt:new Date().toISOString()});
test.before(async () => {
  if (!uri) return;
  if (!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri)) throw new Error('Isolated test DB required');
  await mongoose.connect(uri);
  for (const model of [...Object.values(models), require('../../src/models/managedFile'), require('../../src/models/fileChunk'), require('../../src/models/fileQuota')]) await model.createIndexes();
  test.mock.method(require('../../src/services/tokenLedger'),'notifyCommitted',()=>{});
  // Fail closed if a test forgets to mock either external service.
  test.mock.method(Completions.prototype,'create',()=>{throw new Error('Unexpected provider request');});
  test.mock.method(reader,'read',()=>{throw new Error('Unexpected web fetch');});
});
test.after(async()=>{ if(uri){await mongoose.connection.dropDatabase();await mongoose.disconnect();} });
test.beforeEach(()=>{process.env.WEB_READING_V2_ENABLED='true';process.env.BROWSER_V2_ENABLED='true';worker.setIo(null);});
async function fixture({balance=10000,model={}}={}) {
  const id=crypto.randomUUID();
  const user=await models.User.create({email:`web-${id}@example.test`,name:'Web test',status:'active',appTokens:balance});
  const modelId=`web-${id}`;
  await models.ChatModels.create({modelId,enabled:true,inputPerM:2.5,outputPerM:10,...model});
  const conversation=await models.ChatConversation.create({user:user.id,modelId});
  const payload={clientMessageId:crypto.randomUUID(),conversationId:conversation.id,modelId,message:'https://example.com/a',files:[]};
  return {user,conversation,modelId,payload};
}
async function run(f) {const accepted=await accept({userId:f.user.id,payload:f.payload});const claimed=await worker.claimTurn(accepted.turn.turnId);await worker.processTurn(claimed);return models.ChatTurn.findById(claimed.turn._id).lean();}
function provider(t, inspect=()=>{}) {let calls=0;t.mock.method(Completions.prototype,'create',async function*(req){calls++;await inspect(req);yield {choices:[{delta:{content:'Summary.'},finish_reason:null}]};yield {choices:[{delta:{},finish_reason:'stop'}],usage};});return ()=>calls;}

const sessions=require('../../src/services/browser/session');
const accounting=require('../../src/services/browser/accounting');
function browser(t) {let actions=0;t.mock.method(sessions,'create',()=>({close(){},async action(){actions++;return {...page('https://example.com/a'),controls:[]};}}));return ()=>actions;}
function answer(t,{failAt=0,ambiguous=false,selected}={}) {let calls=0;t.mock.method(Completions.prototype,'create',async req=>{
  if (selected && req.stream) return require('../web/sourceSelectionStream')(selected, usage);
  calls++;if(calls===failAt)throw Object.assign(new Error('test'),ambiguous?{}:{status:429});
  return calls===1?{usage,choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'1',type:'function',function:{name:'browse',arguments:'{"kind":"done"}'}}]}}]}:{usage,choices:[{finish_reason:'stop',message:{content:'Browser answer'}}]};
});return ()=>calls;}
test('browser plan, multi-call usage, one debit, private sources and reload',opts,async t=>{
  const f=await fixture();const actions=browser(t),calls=answer(t);const row=await run(f);
  assert.equal(row.webPlan.mode,'browser');assert.equal(row.status,'completed');assert.equal(row.reservationState,'settled');
  assert.equal(row.usage.totalTokens,240);assert.equal(calls(),2);assert.equal(actions(),1);
  assert.equal((await models.User.findById(f.user.id)).reservedAppTokens,0);
  assert.equal(await models.TokenOperation.countDocuments({'context.turnId':row.turnId,'entries.delta':{$lt:0}}),1);
  const dto=await snapshot(row);assert.match(dto.assistantMessage.content,/Browser answer/);assert.equal(dto.assistantMessage.webSources[0].text,undefined);
});
test('only the requested public source is passed to the browser session and opened', opts, async t => {
  const guide = 'https://example.org/guide';
  const f = await fixture();
  f.payload.message = 'У прикладі http://192.168.0.1 та https://example.net/other. Прочитай інструкцію ' + guide;
  const opened = [];
  t.mock.method(sessions, 'create', urls => {
    assert.deepEqual(urls, [guide]);
    return { close() {}, async action(action) {
      opened.push(action);
      return { ...page(guide), controls: [] };
    } };
  });
  answer(t, { selected: [guide] });
  const turn = await run(f);
  assert.equal(turn.status, 'completed');
  assert.equal(turn.webPlan.mode, 'browser');
  assert.deepEqual(opened, [{ kind: 'open', url: guide }]);
});

test('comparison visits both selected sources before the model can finish', opts, async t => {
  const sources = ['https://example.org/first', 'https://example.net/second'];
  const f = await fixture();
  f.payload.message = 'Адреса роутера http://192.168.0.1. Порівняй ' + sources.join(' та ');
  const opened = [];
  t.mock.method(sessions, 'create', urls => {
    assert.deepEqual(urls, sources);
    return { close() {}, async action({ url }) {
      opened.push(url);
      return { ...page(url), controls: [] };
    } };
  });
  answer(t, { selected: sources });
  const turn = await run(f);
  assert.equal(turn.status, 'completed');
  assert.deepEqual(opened, sources);
  assert.deepEqual(turn.webState.results.map(r => r.requestedUrl), sources);
  assert.equal(turn.usage.totalTokens, 360);
});

test('zero-call failure releases; known failure after paid call settles partial once; ambiguous retains',opts,async t=>{
  for(const [failAt,ambiguous,expected] of [[1,false,'failed'],[2,false,'completed'],[2,true,'failed']]){
    const f=await fixture();browser(t);answer(t,{failAt,ambiguous});const row=await run(f);
    assert.equal(row.status,expected);assert.equal(row.needsReconciliation,ambiguous);
    assert.equal(row.reservationState,ambiguous?'held':failAt===1?'released':'settled');
    if(failAt===2&&!ambiguous)assert.equal(row.usage.totalTokens,120);
  }
});
test('recovery after checkpoint settles recorded usage without replaying actions or provider',opts,async t=>{
  const f=await fixture();const a=await accept({userId:f.user.id,payload:f.payload});const c=await worker.claimTurn(a.turn.turnId);
  const actions=browser(t),calls=answer(t);
  await models.ChatTurn.updateOne({_id:c.turn._id},{$set:{providerStartedAt:new Date(),leaseUntil:new Date(0),
    browserState:{calls:1,pending:false,usage:{promptTokens:100,completionTokens:20,totalTokens:120}}}});
  await worker.recoverExpired();await worker.recoverExpired();const row=await models.ChatTurn.findById(c.turn._id);
  assert.equal(row.status,'completed');assert.equal(row.usage.totalTokens,120);assert.equal(actions(),0);assert.equal(calls(),0);
  assert.equal(await models.TokenOperation.countDocuments({'context.turnId':row.turnId,'entries.delta':{$lt:0}}),1);
});
test('concurrent boundary claims reserve once; stale lease cannot execute a second call',opts,async()=>{
  const f=await fixture();const a=await accept({userId:f.user.id,payload:f.payload});const c=await worker.claimTurn(a.turn.turnId);
  const results=await Promise.allSettled([1,2].map(()=>accounting.begin(c.turn,c.leaseToken,[{role:'user',content:'Read'}],[])));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(await models.TokenOperation.countDocuments({key:`reservation_hold:web:${c.turn.turnId}:1:browser:1`}),1);
  await accounting.received(c.turn,c.leaseToken,{prompt_tokens:0,completion_tokens:0,total_tokens:0});
  await worker.failTurn(c.turn,c.leaseToken,{code:'INTERNAL_ERROR',message:'cleanup',retryable:false},{knownNoCharge:true});
});
test('model opt-out uses working HTML reader, ordinary requests never launch browser',opts,async t=>{
  const f=await fixture({model:{browserInputEnabled:false}});t.mock.method(reader,'read',async url=>page(url));
  const actions=browser(t);provider(t);const row=await run(f);assert.equal(row.webPlan.mode,undefined);assert.equal(row.status,'completed');assert.equal(actions(),0);
});
test('nullable browse arguments execute canonical action, persist diagnostic and settle one aggregate charge',opts,async t=>{
  const f=await fixture();const performed=[];let calls=0;
  t.mock.method(sessions,'create',()=>({close(){},async action(a){performed.push(a);return {...page('https://example.com/a'),controls:[{kind:'follow',ref:'b1'}]};}}));
  t.mock.method(Completions.prototype,'create',async req=>{
    calls++;
    if(calls<3){
      assert.equal(req.tools[0].function.strict,true);
      return {usage,choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'1',type:'function',function:{name:'browse',arguments:JSON.stringify(calls===1?{kind:'follow',ref:'b1',query:null,url:null}:{kind:'done',ref:null,query:null,url:null})}}]}}]};
    }
    return {usage,choices:[{finish_reason:'stop',message:{content:'Actual article summary'}}]};
  });
  const row=await run(f);assert.equal(row.status,'completed');assert.equal(calls,3);assert.equal(performed.length,2);
  assert.deepEqual(performed[1],{kind:'follow',ref:'b1'});assert.equal(row.usage.totalTokens,360);
  assert.equal(row.browserState.lastActionDiagnostic.reason,'ACCEPTED');assert.equal(row.reservationState,'settled');
  assert.equal((await models.User.findById(f.user.id)).reservedAppTokens,0);
  assert.equal(await models.TokenOperation.countDocuments({'context.turnId':row.turnId,'entries.delta':{$lt:0}}),1);
});
test('rejection diagnostic survives reload without raw arguments or an additional provider call',opts,async t=>{
  const f=await fixture();const actions=browser(t);let calls=0;
  t.mock.method(Completions.prototype,'create',async()=>{calls++;return {usage,choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'browse',arguments:'{"kind":"done","query":"PRIVATE_SECRET"}'}}]}}]};});
  const row=await run(f);assert.equal(calls,1);assert.equal(actions(),1);assert.equal(row.status,'completed');
  assert.equal(row.browserState.lastActionDiagnostic.reason,'UNUSED_ARGUMENT_NOT_EMPTY');
  assert.equal(row.browserState.lastActionDiagnostic.field,'query');assert.ok(!JSON.stringify(row.browserState).includes('PRIVATE_SECRET'));
  assert.equal(row.usage.totalTokens,120);assert.equal(row.reservationState,'settled');
  assert.equal(await models.TokenOperation.countDocuments({'context.turnId':row.turnId,'entries.delta':{$lt:0}}),1);
});
test('navigation failure finalizes saved evidence, persists diagnostics and bills exactly once through recovery',opts,async t=>{
  const f=await fixture();let actions=0,calls=0;
  t.mock.method(sessions,'create',()=>({close(){},async action(){
    if(++actions===1)return {...page('https://example.com/a'),text:'UNIQUE_SAVED_PAGE',controls:[{kind:'follow',ref:'b1'}]};
    throw Object.assign(new Error('SECRET_URL'),{webError:'BROWSER_LIMIT',browserSessionDiagnostic:{reason:'RESOURCE_LIMIT',stage:'navigate',actionIndex:2}});
  }}));
  t.mock.method(Completions.prototype,'create',async req=>{
    if(++calls===1)return {usage,choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'1',type:'function',function:{name:'browse',arguments:'{"kind":"follow","ref":"b1"}'}}]}}]};
    assert.equal(req.tools,undefined);assert.match(JSON.stringify(req.messages),/UNIQUE_SAVED_PAGE/);
    return {usage,choices:[{finish_reason:'stop',message:{content:'Summary of saved page'}}]};
  });
  const row=await run(f);await worker.recoverExpired();await worker.recoverExpired();
  assert.equal(row.status,'completed');assert.equal(row.reservationState,'settled');assert.equal(row.usage.totalTokens,240);
  assert.equal(calls,2);assert.equal(actions,2);assert.equal(row.browserState.navigationIncomplete,true);
  assert.equal(row.browserState.lastSessionDiagnostic.reason,'RESOURCE_LIMIT');
  assert.ok(!JSON.stringify(row.browserState).includes('SECRET_URL'));
  assert.equal((await models.User.findById(f.user.id)).reservedAppTokens,0);
  assert.equal(await models.TokenOperation.countDocuments({'context.turnId':row.turnId,'entries.delta':{$lt:0}}),1);
  const restored=await snapshot(row);assert.match(restored.assistantMessage.content,/Summary of saved page/);assert.match(restored.assistantMessage.content,/incomplete/);
  assert.equal(restored.assistantMessage.webSources.length,1);assert.equal(restored.assistantMessage.webSources[0].text,undefined);
});
test('ambiguous fallback provider call is held for reconciliation without automatic replay',opts,async t=>{
  const f=await fixture();let actions=0,calls=0;
  t.mock.method(sessions,'create',()=>({close(){},async action(){
    if(++actions===1)return {...page('https://example.com/a'),controls:[{kind:'follow',ref:'b1'}]};
    throw Object.assign(new Error(),{webError:'BROWSER_TIMEOUT'});
  }}));
  t.mock.method(Completions.prototype,'create',async()=>{
    if(++calls===1)return {usage,choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'1',type:'function',function:{name:'browse',arguments:'{"kind":"follow","ref":"b1"}'}}]}}]};
    throw new Error('provider disconnect');
  });
  const row=await run(f);await worker.recoverExpired();
  assert.equal(row.status,'failed');assert.equal(row.reservationState,'held');assert.equal(row.needsReconciliation,true);
  assert.equal(calls,2);assert.equal(actions,2);
  assert.equal(await models.TokenOperation.countDocuments({'context.turnId':row.turnId,'entries.delta':{$lt:0}}),0);
});

for (const mode of ['browser', 'html']) {
  test(mode + ' reads through a long snapshot, resumes once after duplicate clicks and settles actual usage', opts, async t => {
    const f = await fixture({ balance: 2000000 });
    process.env.BROWSER_V2_ENABLED = String(mode === 'browser');
    const paging = require('../../src/services/web/paging');
    const code = crypto.randomUUID();
    const snapshotText = 'abcdefghijklmnop '.repeat(20000) + '\nLast paragraph code: ' + code;
    const source = { ...page(f.payload.message), text: snapshotText.slice(0, 8192),
      snapshot: snapshotText, truncated: true, controls: [] };
    let reads = 0;
    const read = async () => { reads++; return source; };
    if (mode === 'browser') t.mock.method(sessions, 'create', () => ({ close() {}, action: read }));
    else t.mock.method(reader, 'read', read);
    const seen = [];
    t.mock.method(Completions.prototype, 'create', async req => {
      const input = req.messages.map(m => {
        try { return JSON.parse(m.content); } catch { return null; }
      }).find(p => p?.parts);
      assert.ok(input);
      for (const part of input.parts) {
        assert.equal(part.part, seen.length + 1, 'every part must be sent exactly once');
        seen.push(part.part);
      }
      const found = input.parts.find(part => part.text.includes(code));
      return { usage, choices: [{ finish_reason: 'stop', message: { content: found ? code : 'Saved notes' } }] };
    });
    // The first turn has five paid calls, the remainder starts in the next turn.
    const first = await run(f);
    assert.equal(first.status, 'completed', JSON.stringify(first.error));
    assert.equal(first.webReading.cursor, 25);
    const firstView = (await snapshot(first)).assistantMessage;
    assert.equal(firstView.webSources[0].reading.continueId, first.turnId);
    assert.ok(!JSON.stringify(firstView).includes(code));
    const payload = { ...f.payload, message: 'Continue reading', clientMessageId: first.turnId };
    const submit = () => accept({ userId: f.user.id, payload });
    const children = await Promise.all([submit(), submit()]);
    assert.equal(children[0].turn.turnId, children[1].turn.turnId);
    const claimed = await worker.claimTurn(children[0].turn.turnId);
    await worker.processTurn(claimed);
    const child = await models.ChatTurn.findById(claimed.turn._id).lean();
    assert.equal(child.status, 'completed', JSON.stringify(child.error));
    assert.equal(child.webReading.finished, true);
    assert.equal(child.webState.results[0].snapshot, undefined);
    const answer = (await snapshot(child)).assistantMessage;
    assert.ok(answer.content.includes(code));
    assert.equal(answer.webSources[0].truncated, false);
    assert.equal(answer.webSources[0].reading.continueId, undefined);
    assert.equal(seen.length, paging.split(snapshotText).length);
    assert.equal(reads, 1);
    assert.equal(first.usage.totalTokens + child.usage.totalTokens, 6 * usage.total_tokens);
    assert.equal((await models.User.findById(f.user.id)).reservedAppTokens, 0);
  });
}

for (const mode of ['html', 'browser']) {
  test(mode + ' model-selected lookup searches the last paragraph and reports scoped coverage', opts, async t => {
    process.env.BROWSER_V2_ENABLED = String(mode === 'browser');
    const f = await fixture({balance: 100000});
    const url = f.payload.message;
    const marker = crypto.randomUUID();
    const text = 'start-of-snapshot ' + 'Release notes. '.repeat(18000) + 'Appendix 9.8 ' + marker;
    const source = { ...page(url), text:text.slice(0,8192), snapshot:text, truncated:true, controls:[] };
    f.payload.message = 'Прочитай ' + url + ' і назви контрольний код у Appendix 9.8';
    const read = async () => source;
    if (mode === 'browser') t.mock.method(sessions,'create',()=>({close(){},action:read}));
    else t.mock.method(reader,'read',read);
    t.mock.method(Completions.prototype,'create',async req => {
      if (req.stream) return (async function* () {
        yield {choices:[{delta:{tool_calls:[{index:0,id:'select',type:'function',function:{name:'read_supplied_pages',
          arguments:JSON.stringify({urls:[url], purpose:'read',needle:'Appendix 9.8'})}}]},finish_reason:'tool_calls'}]};
        yield {choices:[],usage};
      })();
      const evidence = JSON.stringify(req.messages);
      assert.ok(!evidence.includes('start-of-snapshot'));
      assert.ok(evidence.includes(marker));
      return {usage, choices:[{finish_reason:'stop',message:{content:marker}}]};
    });
    const result = await run(f);
    assert.equal(result.status,'completed', JSON.stringify(result.error));
    const msg = (await snapshot(result)).assistantMessage;
    assert.ok(msg.content.includes(marker));
    assert.equal(msg.webSources[0].reading.read, msg.webSources[0].reading.selected);
    assert.ok(msg.webSources[0].reading.read < msg.webSources[0].reading.total);
    assert.equal(msg.webSources[0].reading.canContinue,false);
    assert.equal(result.usage.totalTokens,2 * usage.total_tokens);
  });
}

test('balance pause before the first paid batch can resume after a top-up without a new fetch', opts, async t => {
  process.env.BROWSER_V2_ENABLED='false';
  const f=await fixture({balance:100});
  const url=f.payload.message;
  const text='Details. '.repeat(3500);
  let reads=0;
  t.mock.method(reader,'read',async()=>{reads++;return {...page(url),text:text.slice(0,8192),snapshot:text,truncated:true};});
  const paused=await run(f);
  assert.equal(paused.status,'completed',JSON.stringify(paused.error));
  assert.equal(paused.usage.totalTokens,0);
  assert.equal(paused.webReading.cursor,0);
  const before=await models.User.findById(f.user.id);
  assert.equal(before.appTokens,100);
  assert.equal(before.reservedAppTokens,0);
  await models.User.updateOne({_id:before._id},{$set:{appTokens:100000}});
  f.payload={...f.payload,clientMessageId:paused.turnId,message:'Continue reading'};
  t.mock.method(Completions.prototype,'create',async()=>({usage,choices:[{finish_reason:'stop',message:{content:'Done'}}]}));
  const done=await run(f);
  assert.equal(done.webReading.finished,true);
  assert.equal(reads,1);
});
