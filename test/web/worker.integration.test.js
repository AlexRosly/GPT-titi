process.env.OPENAI_API_KEY ||= 'test-placeholder-not-a-real-key';
process.env.OCR_ENABLED='false';process.env.PRIVATE_FILES_ENABLED='true';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),mongoose=require('mongoose');
const models=require('../../src/models'),worker=require('../../src/services/chatDeliveryV2/worker'),accept=require('../../src/services/chatDeliveryV2/acceptTurn');
const retry=require('../../src/services/chatDeliveryV2/retryTurn'),reconcile=require('../../src/services/chatDeliveryV2/reconcileReservation');
const fetcher=require('../../src/services/web/fetch'),flow=require('../../src/services/web/flow');
const {snapshot}=require('../../src/services/chatDeliveryV2/snapshot');
const {Completions}=require('openai/resources/chat/completions');
const uri=process.env.FILES_TEST_MONGO_URI;let modelId='web-test-model';
test.before(async()=>{
 if(!uri)return;
 if(!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri))throw Error('Dedicated test DB required');
 await mongoose.connect(uri);
 for(const model of [...Object.values(models),require('../../src/models/managedFile'),require('../../src/models/fileQuota'),require('../../src/models/fileChunk')])await model.createIndexes();
 await models.ChatModels.create({modelId,enabled:true,inputPerM:1,outputPerM:2});
});
test.after(async()=>{if(uri){await mongoose.connection.dropDatabase();await mongoose.disconnect();}});
async function fixture(message='Порівняй https://example.com/a та https://example.org/b',extra={}){
 const user=await models.User.create({email:crypto.randomUUID()+'@example.test',name:'Web',status:'active',appTokens:100000});
 const conversation=await models.ChatConversation.create({user:user._id,modelId});
 const payload={clientMessageId:crypto.randomUUID(),conversationId:conversation.id,modelId,message,files:[],...extra};
 const accepted=await accept({userId:user._id,payload});return {user,conversation,payload,turn:accepted.turn};
}
const selection=indices=>({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'web_call',type:'function',function:{name:'read_webpage',arguments:JSON.stringify({indices})}}]}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
async function* answer(){yield {choices:[{delta:{content:'Підсумок прочитаних сторінок.'}}]};yield {choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}};}
const result=url=>({url,title:'Source',text:'Private fetched evidence 731',fetchedAt:new Date().toISOString(),truncated:false});
function provider(t,indices=[0,1]){let calls=0;t.mock.method(Completions.prototype,'create',async request=>{calls++;if(!request.stream)return selection(indices);assert.ok(request.messages.some(m=>m.role==='tool'));assert.equal(request.max_completion_tokens,8192);return answer();});return ()=>calls;}
test('web V2 reads supplied URLs, sums both calls, saves sources and completes one charge', {skip:!uri},async t=>{
 const count=provider(t);let reads=0;t.mock.method(fetcher,'read',async url=>{reads++;return result(url);});
 const f=await fixture();assert.ok(f.turn.webPlan);assert.ok(f.turn.reservedAppTokens>0);
 await worker.processTurn(await worker.claimTurn(f.turn.turnId));
 const done=await models.ChatTurn.findById(f.turn._id);assert.equal(done.status,'completed');assert.equal(done.reservationState,'settled');assert.equal(done.usage.totalTokens,150);
 assert.equal(count(),2);assert.equal(reads,2);assert.equal(await models.ChatBillingLedger.countDocuments({turnId:done.turnId}),1);
 const snap=await snapshot(done);assert.equal(snap.assistantMessage.webSources.length,2);
 let restored;await require('../../src/controllers/chat/getChatHistory')({user:{id:f.user.id}},{json:value=>{restored=value;}});assert.equal(restored.messages.find(m=>m.role==='assistant').webSources.length,2);
 let foreign;await require('../../src/controllers/chat/getChatHistory')({user:{id:new mongoose.Types.ObjectId().toString()}},{json:value=>{foreign=value;}});assert.equal(foreign.messages.length,0);assert.equal('text' in snap.assistantMessage.webSources[0],false);assert.match(snap.assistantMessage.content,/https:\/\/example.com\/a/);
 assert.equal((await models.User.findById(f.user._id)).reservedAppTokens,0);
 const duplicate=await accept({userId:f.user._id,payload:f.payload});assert.equal(duplicate.disposition,'duplicate');await worker.recoverExpired();assert.equal(count(),2);
});
test('expired reading checkpoint resumes missing page only, without another selector call', {skip:!uri},async t=>{
 const f=await fixture(),claim=await worker.claimTurn(f.turn.turnId);let reads=0,calls=0;
 t.mock.method(fetcher,'read',async url=>{reads++;assert.equal(url,'https://example.org/b');return result(url);});
 t.mock.method(Completions.prototype,'create',async request=>{calls++;assert.equal(request.stream,true);return answer();});
 const state={phase:'reading',...flow.selection(selection([0,1]),f.turn.webPlan.urls),usage:{promptTokens:20,completionTokens:10,totalTokens:30},results:[{index:0,requestedUrl:'https://example.com/a',status:'ready',...result('https://example.com/a')}]};
 await models.ChatTurn.updateOne({_id:claim.turn._id},{$set:{webState:state,providerStartedAt:new Date(),leaseUntil:new Date(0)}});
 await worker.recoverExpired();const done=await models.ChatTurn.findById(f.turn._id);assert.equal(done.status,'completed');assert.equal(reads,1);assert.equal(calls,1);assert.equal(done.usage.totalTokens,150);
});
test('ambiguous final call holds reservation and reconciliation includes completed selector usage', {skip:!uri},async t=>{
 const f=await fixture(),claim=await worker.claimTurn(f.turn.turnId);let calls=0;t.mock.method(Completions.prototype,'create',async()=>{calls++;throw Error('must not replay');});
 await models.ChatTurn.updateOne({_id:claim.turn._id},{$set:{providerStartedAt:new Date(),leaseUntil:new Date(0),webState:{phase:'final_started',usage:{promptTokens:20,completionTokens:10,totalTokens:30},results:[]}}});
 await worker.recoverExpired();let done=await models.ChatTurn.findById(f.turn._id);assert.equal(done.needsReconciliation,true);assert.equal(done.reservationState,'held');assert.equal(calls,0);
 await reconcile({turnId:done.turnId,attempt:1,noCharge:true,reason:'Provider confirms unresolved final call was not billed'});
 done=await models.ChatTurn.findById(f.turn._id);assert.equal(done.reservationState,'settled');assert.equal(done.reconciliation.usage.total_tokens,30);assert.equal(await models.ChatBillingLedger.countDocuments({turnId:done.turnId}),1);
});
test('known final rejection settles completed selector once and releases remaining reserve', {skip:!uri},async t=>{
 t.mock.method(fetcher,'read',async url=>result(url));
 t.mock.method(Completions.prototype,'create',async request=>{if(!request.stream)return selection([0]);throw Object.assign(new Error('rejected'),{status:400});});
 const f=await fixture();await worker.processTurn(await worker.claimTurn(f.turn.turnId));const done=await models.ChatTurn.findById(f.turn._id);
 assert.equal(done.status,'failed');assert.equal(done.needsReconciliation,false);assert.equal(done.reservationState,'settled');assert.equal(done.error.retryable,false);assert.equal(await models.ChatBillingLedger.countDocuments({turnId:done.turnId}),1);assert.equal((await models.User.findById(f.user._id)).reservedAppTokens,0);
});
test('selector rejection with no usage releases reserve and retry remains possible', {skip:!uri},async t=>{
 t.mock.method(Completions.prototype,'create',async()=>{throw Object.assign(new Error('limited'),{status:429});});
 const f=await fixture();await worker.processTurn(await worker.claimTurn(f.turn.turnId));const done=await models.ChatTurn.findById(f.turn._id);
 assert.equal(done.reservationState,'released');assert.equal(done.error.retryable,true);assert.equal(await models.ChatBillingLedger.countDocuments({turnId:done.turnId}),0);
 const retried=await retry({turnId:done.turnId,userId:f.user._id});assert.equal(retried.attempt,2);assert.equal(retried.webState,null);
 await worker.processTurn(await worker.claimTurn(done.turnId));
});
test('web opt-out leaves ordinary requests unchanged; URL limits roll back admission', {skip:!uri},async t=>{
 await models.ChatModels.updateOne({modelId},{$set:{webInputEnabled:false}});t.after(()=>models.ChatModels.updateOne({modelId},{$set:{webInputEnabled:true}}));
 let calls=0;t.mock.method(Completions.prototype,'create',async request=>{calls++;assert.equal(request.stream,true);return answer();});
 const f=await fixture();assert.equal(f.turn.webPlan,null);await worker.processTurn(await worker.claimTurn(f.turn.turnId));assert.equal(calls,1);
 await models.ChatModels.updateOne({modelId},{$set:{webInputEnabled:true}});
 const before=await models.ChatTurn.countDocuments({user:f.user._id});
 await assert.rejects(accept({userId:f.user._id,payload:{...f.payload,clientMessageId:crypto.randomUUID(),message:'https://a.com https://b.com https://c.com https://d.com'}}),{webError:'WEB_TOO_MANY_URLS'});
 assert.equal(await models.ChatTurn.countDocuments({user:f.user._id}),before);assert.equal((await models.User.findById(f.user._id)).reservedAppTokens,0);
});
test('failed pages still produce a bounded answer with actionable source errors', {skip:!uri},async t=>{
 provider(t,[0]);t.mock.method(fetcher,'read',async()=>{throw require('../../src/services/web/policy').fail('WEB_JAVASCRIPT_REQUIRED');});
 const f=await fixture();await worker.processTurn(await worker.claimTurn(f.turn.turnId));const done=await models.ChatTurn.findById(f.turn._id),snap=await snapshot(done);
 assert.equal(done.status,'completed');assert.equal(snap.assistantMessage.webSources[0].error,'WEB_JAVASCRIPT_REQUIRED');assert.equal(snap.assistantMessage.webSources[0].status,'failed');assert.equal(snap.assistantMessage.webSources[0].url,undefined);
});
test('stored final web result completes without another model request or download', {skip:!uri},async t=>{
 const f=await fixture(),claim=await worker.claimTurn(f.turn.turnId);let calls=0;
 t.mock.method(Completions.prototype,'create',async()=>{calls++;throw Error('must not call');});t.mock.method(fetcher,'read',async()=>{throw Error('must not fetch');});
 await models.ChatTurn.updateOne({_id:claim.turn._id},{$set:{providerStartedAt:new Date(),leaseUntil:new Date(0),webState:{phase:'final_started',results:[{index:0,requestedUrl:'https://example.com/a',status:'ready',...result('https://example.com/a')}]},providerResult:{assistantText:'Saved answer',usage:{promptTokens:120,completionTokens:30,totalTokens:150}}}});
 await worker.recoverExpired();await worker.recoverExpired();const done=await models.ChatTurn.findById(f.turn._id);assert.equal(done.status,'completed');assert.equal(calls,0);assert.equal((await snapshot(done)).assistantMessage.webSources.length,1);assert.equal(await models.ChatBillingLedger.countDocuments({turnId:done.turnId}),1);
});
test('insufficient web reserve rejects admission without retained turn or debit', {skip:!uri},async()=>{
 const f=await fixture('ordinary');await worker.failTurn((await worker.claimTurn(f.turn.turnId)).turn,(await models.ChatTurn.findById(f.turn._id)).leaseToken,{code:'INTERNAL_ERROR',message:'test',retryable:false},{knownNoCharge:true});
 await models.User.updateOne({_id:f.user._id},{$set:{appTokens:1}});
 const count=await models.ChatTurn.countDocuments({user:f.user._id});
 await assert.rejects(accept({userId:f.user._id,payload:{...f.payload,clientMessageId:crypto.randomUUID(),message:'read https://example.com'}}),e=>e.protocolError?.code==='INSUFFICIENT_BALANCE');
 assert.equal(await models.ChatTurn.countDocuments({user:f.user._id}),count);assert.equal((await models.User.findById(f.user._id)).reservedAppTokens,0);
});
test('web reading composes with automatic private file generation and retains sources', {skip:!uri},async t=>{
 t.mock.method(fetcher,'read',async url=>result(url));
 t.mock.method(Completions.prototype,'create',async request=>{
  if(!request.stream)return selection([0]);
  assert.ok(request.tools.some(tool=>tool.function.name==='create_file'));
  return (async function*(){yield {choices:[{delta:{tool_calls:[{index:0,function:{name:'create_file',arguments:JSON.stringify({filename:'web-summary.txt',content:'Private fetched evidence 731',summary:'Готово'})}}]},finish_reason:'tool_calls'}]};yield {choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}};})();
 });
 const f=await fixture('Read https://example.com and save as TXT');await worker.processTurn(await worker.claimTurn(f.turn.turnId));const done=await models.ChatTurn.findById(f.turn._id),snap=await snapshot(done);
 assert.equal(done.status,'completed');assert.equal(snap.assistantMessage.fileResult.status,'ready');assert.equal(snap.assistantMessage.webSources.length,1);assert.match(snap.assistantMessage.content,/https:\/\/example.com/);
 const file=await require('../../src/services/files/store').read(f.user._id,snap.assistantMessage.attachments[0].fileId);assert.match(file.buffer.toString(),/731/);
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:done.turnId}),1);
});
