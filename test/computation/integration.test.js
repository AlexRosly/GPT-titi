const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
process.env.OPENAI_API_KEY||='mock-not-a-key';process.env.PRIVATE_FILES_ENABLED='true';process.env.COMPUTE_V2_ENABLED='true';process.env.OCR_ENABLED='false';
const mongoose=require('mongoose'),models=require('../../src/models');
const File=require('../../src/models/managedFile'),Quota=require('../../src/models/fileQuota'),Chunk=require('../../src/models/fileChunk'),Lease=require('../../src/models/computationLease');
const store=require('../../src/services/files/store'),sandbox=require('../../src/services/computation/session');
const accept=require('../../src/services/chatDeliveryV2/acceptTurn'),worker=require('../../src/services/chatDeliveryV2/worker');
const {Completions}=require('openai/resources/chat/completions');const accounting=require('../../src/services/computation/accounting');
const uri=process.env.FILES_TEST_MONGO_URI,opts={skip:!uri};
const usage={prompt_tokens:100,completion_tokens:30,total_tokens:130},u={promptTokens:100,completionTokens:30,totalTokens:130};
test.before(async()=>{if(!uri)return;if(!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri))throw Error('Dedicated test DB required');await mongoose.connect(uri);for(const m of [...Object.values(models),File,Quota,Chunk,Lease])await m.createIndexes();test.mock.method(require('../../src/services/tokenLedger'),'notifyCommitted',()=>{});test.mock.method(Completions.prototype,'create',()=>{throw Error('Unexpected paid call');});test.mock.method(sandbox,'run',()=>{throw Error('Unexpected Docker call');});});
test.after(async()=>{if(uri){await mongoose.connection.dropDatabase();await mongoose.disconnect();}});
async function fixture(extra={}){
 const id=crypto.randomUUID(),modelId='compute-'+id;
 const user=await models.User.create({email:id+'@example.test',name:'Compute test',status:'active',appTokens:100000});
 await models.ChatModels.create({modelId,enabled:true,inputPerM:1,outputPerM:2,...extra});
 const conversation=await models.ChatConversation.create({user:user.id,modelId});
 const file=await store.create({user:user.id,name:'дані.csv',mimetype:'text/plain',buffer:Buffer.from('v\n1\n2\n3')});
 const payload={clientMessageId:crypto.randomUUID(),conversationId:conversation.id,modelId,message:'Calculate the sum and return a CSV',files:[{fileId:file.id,storage:'private'}]};
 const admitted=await accept({userId:user.id,payload}),claim=await worker.claimTurn(admitted.turn.turnId);
 return {user,modelId,conversation,file,payload,claim};
}
function provider(t,f,{uncertain=false,plain=false}={}){
 let n=0;t.mock.method(Completions.prototype,'create',req=>{
  n++;
  if(req.stream)return (async function*(){
   if(plain){assert.ok(!req.tools?.some(t=>t.function.name==='run_python'));yield {choices:[{delta:{content:'Plain reply'},finish_reason:'stop'}],usage};return;}
   assert.ok(req.tools.some(t=>t.function.name==='run_python'));
   yield {choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'run_python',arguments:JSON.stringify({code:'print(6)',fileIds:[f.file.id],exports:[{path:'out',filename:'result.csv'}]})}}]},finish_reason:'tool_calls'}],usage};
  })();
  assert.ok(req.max_completion_tokens<=2048);
  if(uncertain)return Promise.reject(Error('Socket disconnected after provider boundary'));
  return Promise.resolve({choices:[{message:{content:'The sum is 6. Result attached.'},finish_reason:'stop'}],usage});
 });return ()=>n;
}
function execution(t){let n=0;t.mock.method(sandbox,'run',async req=>{n++;assert.match(req.files[0].path,/дані.csv/);return {ok:true,text:'6',truncated:false,exports:[{filename:'result.csv',data:Buffer.from('sum\n6').toString('base64')}]};});return ()=>n;}
test('V2 executes authorized input, attaches output, settles once and survives recovery/reload',opts,async t=>{
 const f=await fixture(),calls=provider(t,f),runs=execution(t);await worker.processTurn(f.claim);await worker.recoverExpired();
 const row=await models.ChatTurn.findById(f.claim.turn._id).lean();assert.equal(row.status,'completed');assert.equal(row.reservationState,'settled');assert.equal(calls(),2);assert.equal(runs(),1);assert.equal(row.usage.totalTokens,260);
 const message=await models.ChatMessage.findById(row.assistantMessage);assert.equal(message.attachments.length,1);const result=await store.read(f.user.id,message.attachments[0].fileId);assert.equal(result.file.expiresAt,null);assert.match(result.buffer.toString(),/6/);
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:row.turnId}),1);assert.equal((await models.User.findById(f.user.id)).reservedAppTokens,0);assert.equal(await Lease.countDocuments({}),0);
 assert.equal((await accept({userId:f.user.id,payload:f.payload})).disposition,'duplicate');
});
test('model opt-out preserves plain text path and never starts a sandbox',opts,async t=>{
 const f=await fixture({computationEnabled:false}),calls=provider(t,f,{plain:true});await worker.processTurn(f.claim);const row=await models.ChatTurn.findById(f.claim.turn._id);assert.equal(row.status,'completed');assert.equal(calls(),1);assert.equal(row.computeState,null);
});
test('ambiguous provider call holds reservation without auto replay',opts,async t=>{
 const f=await fixture(),calls=provider(t,f,{uncertain:true});execution(t);await worker.processTurn(f.claim);await worker.recoverExpired();
 const row=await models.ChatTurn.findById(f.claim.turn._id);assert.equal(row.status,'failed');assert.equal(row.needsReconciliation,true);assert.equal(row.reservationState,'held');assert.equal(calls(),2);assert.equal(await models.ChatBillingLedger.countDocuments({turnId:row.turnId}),0);
});
test('saved computation checkpoint recovers its files/known usage without code or model replay',opts,async()=>{
 const f=await fixture();const output=await store.create({user:f.user.id,name:'saved.txt',mimetype:'text/plain',buffer:Buffer.from('6'),source:'generated',resultKey:`${f.claim.turn.turnId}:1:compute:1:0`});
 await models.ChatTurn.updateOne({_id:f.claim.turn._id},{$set:{providerStartedAt:new Date(),leaseUntil:new Date(0),computeState:{pending:false,calls:1,runs:1,executionMs:50,usage:u,initialUsage:u,files:[{fileId:output.id,name:'saved.txt',size:1}]}}});
 await worker.recoverExpired();await worker.recoverExpired();const row=await models.ChatTurn.findById(f.claim.turn._id);assert.equal(row.status,'completed');assert.equal(await models.ChatBillingLedger.countDocuments({turnId:row.turnId}),1);assert.equal((await models.ChatMessage.findById(row.assistantMessage)).attachments.length,1);
});
test('shared leases enforce one per user and two per host across concurrent acquisitions',opts,async()=>{
 const leases=require('../../src/services/computation/leases');const user=crypto.randomUUID();const results=await Promise.allSettled([leases.acquire(user),leases.acquire(user)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const second=await leases.acquire(crypto.randomUUID());await assert.rejects(leases.acquire(crypto.randomUUID()),e=>e.fileError==='COMPUTE_BUSY');
 for(const r of results)if(r.status==='fulfilled')await r.value();await second();assert.equal(await Lease.countDocuments({}),0);
});
test('local budget and balance rejection never cross provider boundary',opts,async()=>{
 const f=await fixture();const state={pending:false,calls:0,usage:u,initialUsage:u,runs:0,files:[]};await models.ChatTurn.updateOne({_id:f.claim.turn._id},{$set:{computeState:state}});f.claim.turn.computeState=state;
 const long=[{role:'user',content:'expensive input '.repeat(10000)}];await assert.rejects(accounting.begin(f.claim.turn,f.claim.leaseToken,long,[]));assert.equal((await models.ChatTurn.findById(f.claim.turn._id)).computeState.pending,false);
 await models.User.updateOne({_id:f.user.id},{$set:{appTokens:1}});await assert.rejects(accounting.begin(f.claim.turn,f.claim.leaseToken,[{role:'user',content:'hi'}],[]));assert.equal((await models.ChatTurn.findById(f.claim.turn._id)).computeState.pending,false);
});
test('no-charge reconciliation for uncertain call still settles earlier completed calls',opts,async()=>{
 const f=await fixture();await models.ChatTurn.updateOne({_id:f.claim.turn._id},{$set:{status:'failed',needsReconciliation:true,providerStartedAt:new Date(),computeState:{pending:true,usage:u,initialUsage:u,files:[]}}});
 const result=await require('../../src/services/chatDeliveryV2/reconcileReservation')({turnId:f.claim.turn.turnId,attempt:1,noCharge:true,reason:'Mock provider evidence: only last call was rejected'});
 assert.equal(result.charged,true);const row=await models.ChatTurn.findById(f.claim.turn._id);assert.equal(row.reservationState,'settled');assert.equal(row.needsReconciliation,false);assert.equal(await models.ChatBillingLedger.countDocuments({turnId:row.turnId}),1);
});
