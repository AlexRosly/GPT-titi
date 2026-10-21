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
test.beforeEach(()=>{process.env.WEB_READING_V2_ENABLED='true';worker.setIo(null);});
async function fixture({balance=10000,model={}}={}) {
  const id=crypto.randomUUID();
  const user=await models.User.create({email:`web-${id}@example.test`,name:'Web test',status:'active',appTokens:balance});
  const modelId=`web-${id}`;
  await models.ChatModels.create({modelId,enabled:true,inputPerM:2.5,outputPerM:10,...model});
  const conversation=await models.ChatConversation.create({user:user.id,modelId});
  const payload={clientMessageId:crypto.randomUUID(),conversationId:conversation.id,modelId,message:'Підсумуй https://example.com/a',files:[]};
  return {user,conversation,modelId,payload};
}
async function run(f) {const accepted=await accept({userId:f.user.id,payload:f.payload});const claimed=await worker.claimTurn(accepted.turn.turnId);await worker.processTurn(claimed);return models.ChatTurn.findById(claimed.turn._id).lean();}
function provider(t, inspect=()=>{}) {let calls=0;t.mock.method(Completions.prototype,'create',async function*(req){calls++;await inspect(req);yield {choices:[{delta:{content:'Summary.'},finish_reason:null}]};yield {choices:[{delta:{},finish_reason:'stop'}],usage};});return ()=>calls;}

test('one model call, actual reserve, private history sources, duplicate admission and single billing',opts,async t=>{
  const f=await fixture();let reads=0;t.mock.method(reader,'read',async url=>{reads++;return page(url);});
  const calls=provider(t,async req=>{
    assert.equal(req.max_completion_tokens,4096);assert.match(JSON.stringify(req.messages),/Український/);
    const row=await models.ChatTurn.findOne({clientMessageId:f.payload.clientMessageId}).lean();
    const user=await models.User.findById(f.user.id).lean();
    assert.ok(row.providerStartedAt);assert.ok(row.webBudget.amount<10000);assert.equal(user.reservedAppTokens,row.reservedAppTokens);
  });
  const turn=await run(f);assert.equal(turn.status,'completed');assert.equal(calls(),1);assert.equal(reads,1);
  assert.equal(turn.usage.totalTokens,120);assert.equal((await models.User.findById(f.user.id)).reservedAppTokens,0);
  const dto=await snapshot(turn);assert.equal(dto.assistantMessage.webSources.length,1);assert.equal(dto.assistantMessage.webSources[0].text,undefined);
  assert.match(dto.assistantMessage.content,/web-1/);
  const duplicate=await accept({userId:f.user.id,payload:f.payload});assert.equal(duplicate.disposition,'duplicate');assert.equal(calls(),1);
  const charge=await models.TokenOperation.find({'context.turnId':turn.turnId,'entries.delta':{$lt:0}});assert.equal(charge.length,1);
  const other=await fixture();await assert.rejects(accept({userId:other.user.id,payload:f.payload}),e=>e.protocolError.code==='CONVERSATION_NOT_FOUND');
});

test('all unreadable pages fail explicitly before provider start and release the admission hold',opts,async t=>{
  for(const code of ['WEB_TIMEOUT','WEB_JAVASCRIPT_REQUIRED','WEB_ACCESS_DENIED']) {
    const f=await fixture();t.mock.method(reader,'read',async()=>{throw fail(code);});const calls=provider(t);
    const turn=await run(f);assert.equal(turn.status,'failed');assert.equal(turn.error.code,code);assert.equal(turn.providerStartedAt,null);
    assert.equal(turn.reservationState,'released');assert.equal(calls(),0);assert.equal((await models.User.findById(f.user.id)).appTokens,10000);
  }
});

test('insufficient actual reserve gives balance details without provider request or a debit',opts,async t=>{
  const f=await fixture({balance:100});t.mock.method(reader,'read',async url=>page(url));const calls=provider(t);
  const turn=await run(f);assert.equal(turn.error.code,'INSUFFICIENT_BALANCE');assert.ok(turn.error.details.estimatedTokens>100);
  assert.equal(turn.reservationState,'released');assert.equal(turn.providerStartedAt,null);assert.equal(calls(),0);
  const user=await models.User.findById(f.user.id);assert.equal(user.appTokens,100);assert.equal(user.reservedAppTokens,0);
});

test('retry after provider rejection reuses successful page cache and charges only successful attempt',opts,async t=>{
  const f=await fixture();let reads=0;t.mock.method(reader,'read',async url=>{reads++;return page(url);});
  t.mock.method(Completions.prototype,'create',async()=>{throw Object.assign(new Error('limited'),{status:429});});
  const failed=await run(f);assert.equal(failed.reservationState,'released');assert.equal(failed.error.retryable,true);
  await retry({turnId:failed.turnId,userId:f.user.id});const calls=provider(t);
  await worker.processTurn(await worker.claimTurn(failed.turnId));
  const done=await models.ChatTurn.findById(failed._id);assert.equal(done.status,'completed');assert.equal(done.attempt,2);assert.equal(reads,1);assert.equal(calls(),1);
  assert.equal(await models.TokenOperation.countDocuments({'context.turnId':done.turnId,'entries.delta':{$lt:0}}),1);
});

test('expired pre-provider work resumes cached pages via scheduler; completed result recovery never calls model',opts,async t=>{
  const f=await fixture();f.payload.message+=' https://example.org/b';const accepted=await accept({userId:f.user.id,payload:f.payload});
  const claimed=await worker.claimTurn(accepted.turn.turnId);
  await models.ChatTurn.updateOne({_id:claimed.turn._id},{$set:{webState:{version:2,results:[{index:0,requestedUrl:'https://example.com/a',status:'ready',...page('https://example.com/a')}]},leaseUntil:new Date(0)}});
  await worker.recoverExpired();assert.equal((await models.ChatTurn.findById(claimed.turn._id)).status,'queued');
  let reads=0;t.mock.method(reader,'read',async url=>{reads++;assert.equal(url,'https://example.org/b');return page(url);});
  const calls=provider(t);await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));assert.equal(reads,1);assert.equal(calls(),1);
  const f2=await fixture();const a2=await accept({userId:f2.user.id,payload:f2.payload});const c2=await worker.claimTurn(a2.turn.turnId);
  await models.ChatTurn.updateOne({_id:c2.turn._id},{$set:{leaseUntil:new Date(0),providerStartedAt:new Date(),webState:{version:2,results:[{index:0,requestedUrl:'https://example.com/a',status:'ready',...page('https://example.com/a')}]},providerResult:{assistantText:'Saved result',usage:{promptTokens:100,completionTokens:20,totalTokens:120}}}});
  await worker.recoverExpired();await worker.recoverExpired();const restored=await models.ChatTurn.findById(c2.turn._id);
  assert.equal(restored.status,'completed');assert.equal(calls(),1);assert.equal(reads,1);
  assert.equal(await models.TokenOperation.countDocuments({'context.turnId':restored.turnId,'entries.delta':{$lt:0}}),1);
});

test('ambiguous provider interruption stays held for reconciliation and is not automatically replayed',opts,async t=>{
  const f=await fixture();t.mock.method(reader,'read',async url=>page(url));let calls=0;
  t.mock.method(Completions.prototype,'create',async()=>{calls++;throw new Error('connection lost');});
  const turn=await run(f);assert.equal(turn.status,'failed');assert.equal(turn.needsReconciliation,true);assert.equal(turn.reservationState,'held');
  await assert.rejects(retry({turnId:turn.turnId,userId:f.user.id}),e=>e.protocolError.code==='TURN_NOT_RETRYABLE');
  await worker.recoverExpired();assert.equal(calls,1);
});

test('flag defaults off, model opt-out and ordinary text preserve the existing single-call path',opts,async t=>{
  delete process.env.WEB_READING_V2_ENABLED;
  const a=await fixture();const calls=provider(t,req=>assert.equal(req.max_completion_tokens,undefined));
  assert.equal((await run(a)).webPlan,null);
  process.env.WEB_READING_V2_ENABLED='true';const b=await fixture({model:{webInputEnabled:false}});assert.equal((await run(b)).webPlan,null);
  const c=await fixture();c.payload.message='Hello';assert.equal((await run(c)).webPlan,null);assert.equal(calls(),3);
});

test('invalid and excessive URLs reject before retention, turn creation and reservation',opts,async()=>{
  for(const message of ['Read http://127.0.0.1','https://a.com https://b.com https://c.com https://d.com']){
    const f=await fixture();f.payload.message=message;
    await assert.rejects(accept({userId:f.user.id,payload:f.payload}),e=>Boolean(e.webError));
    assert.equal(await models.ChatTurn.countDocuments({user:f.user.id}),0);assert.equal((await models.User.findById(f.user.id)).reservedAppTokens,0);
  }
});

test('atomic preparation allows one reservation top-up and one provider boundary under concurrent workers',opts,async t=>{
  const f=await fixture();const a=await accept({userId:f.user.id,payload:f.payload});const c=await worker.claimTurn(a.turn.turnId);
  const results=await Promise.allSettled([1,2].map(()=>reservation.startProvider(c.turn,c.leaseToken,[{role:'user',content:'Prepared web text'}],[])));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(await models.TokenOperation.countDocuments({key:`reservation_hold:web:${c.turn.turnId}:1`}),1);
  const row=await models.ChatTurn.findById(c.turn._id);assert.equal((await models.User.findById(f.user.id)).reservedAppTokens,row.reservedAppTokens);
  await worker.failTurn(row,c.leaseToken,{code:'PROVIDER_UNAVAILABLE',message:'Test cleanup',retryable:true},{knownNoCharge:true});
  assert.equal((await models.User.findById(f.user.id)).reservedAppTokens,0);
});

test('web input coexists with private text attachments and automatic file output',opts,async t=>{
  const f=await fixture();const store=require('../../src/services/files/store');
  const uploaded=await store.create({user:f.user.id,name:'input.txt',mimetype:'text/plain',buffer:Buffer.from('ATTACHMENT CONTENT'),source:'upload'});
  f.payload.files=[{...store.dto(uploaded),storage:'private'}];
  t.mock.method(reader,'read',async url=>page(url));
  t.mock.method(Completions.prototype,'create',async function*(req){
    assert.match(JSON.stringify(req.messages),/ATTACHMENT CONTENT/);assert.match(JSON.stringify(req.messages),/WEB_PAGE_DATA/);
    yield {choices:[{delta:{tool_calls:[{index:0,id:'file-1',type:'function',function:{name:'create_file',arguments:JSON.stringify({filename:'summary.txt',content:'Result text',summary:'Saved'})}}]},finish_reason:'tool_calls'}]};
    yield {choices:[],usage};
  });
  const turn=await run(f);assert.equal(turn.status,'completed');const message=await models.ChatMessage.findById(turn.assistantMessage);
  assert.equal(message.attachments.length,1);assert.equal(message.webSources.length,1);assert.match(message.content,/web-1/);
});

test('Socket.IO send ACK arrives before page work and invalid URLs return an explicit V2 rejection',opts,async t=>{
  const http=require('node:http'),{Server}=require('socket.io'),{io:connect}=require('socket.io-client');
  const f=await fixture();const server=http.createServer();const io=new Server(server);
  io.use((socket,next)=>{socket.user=f.user;next();});
  t.mock.method(worker,'startWorker',async()=>()=>{});t.mock.method(worker,'wake',()=>{});
  require('../../src/controllers/ws/handlers/chatDeliveryV2')(io);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const client=connect(`http://127.0.0.1:${server.address().port}`,{transports:['websocket'],reconnection:false});
  t.after(async()=>{client.close();await new Promise(r=>io.close(r));worker.setIo(null);});
  await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('connect_error',reject);});
  const send=payload=>new Promise((resolve,reject)=>client.timeout(8000).emit('chat:send',{protocolVersion:2,event:'chat:send',type:'request',payload},(error,ack)=>error?reject(error):resolve(ack)));
  const ack=await send(f.payload);assert.equal(ack.ok,true);assert.equal(ack.turn.status,'queued');
  const rejected=await send({...f.payload,clientMessageId:crypto.randomUUID(),message:'Read http://127.0.0.1'});
  assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'WEB_BLOCKED_ADDRESS');
  const row=await models.ChatTurn.findOne({turnId:ack.turn.turnId});assert.equal(row.providerStartedAt,null);assert.equal(row.webState,null);
});
