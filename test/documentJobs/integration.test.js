const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
process.env.OPENAI_API_KEY||='mock-not-a-key';
Object.assign(process.env,{PRIVATE_FILES_ENABLED:'true',COMPUTE_V2_ENABLED:'true',DOCUMENT_JOBS_ENABLED:'true',XLSX_EDIT_ENABLED:'true',OCR_ENABLED:'false'});
const mongoose=require('mongoose'),models=require('../../src/models');
const File=require('../../src/models/managedFile'),Quota=require('../../src/models/fileQuota'),FileChunk=require('../../src/models/fileChunk'),Lease=require('../../src/models/computationLease');
const Job=require('../../src/models/documentJob'),Chunk=require('../../src/models/documentJobChunk'),JobLease=require('../../src/models/documentJobLease');
const store=require('../../src/services/files/store'),queue=require('../../src/services/documentJobs/queue'),processXlsx=require('../../src/services/xlsx/process'),engine=require('../../src/services/xlsx/engine');
const worker=require('../../src/services/chatDeliveryV2/worker'),accept=require('../../src/services/chatDeliveryV2/acceptTurn'),cancel=require('../../src/services/chatDeliveryV2/cancelTurn');
const {Completions}=require('openai/resources/chat/completions');
const {Responses}=require('openai/resources/responses/responses');
const uri=process.env.FILES_TEST_MONGO_URI,opts={skip:!uri};let input,book,selection;
test.before(async()=>{
 if(!uri)return;if(!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri))throw Error('Dedicated disposable replica set database required');
 await mongoose.connect(uri);for(const m of [...Object.values(models),File,Quota,FileChunk,Lease,Job,Chunk,JobLease])await m.createIndexes();
 test.mock.method(require('../../src/services/tokenLedger'),'notifyCommitted',()=>{});
 input=await require('../xlsx/fixtures').fixture(10000);book=engine.load(input);selection=engine.inspect(book,{sheet:'Дані',range:'A2:E10001',where:null,offset:0}).selection;
});
test.after(async()=>{if(uri){await mongoose.connection.dropDatabase();await mongoose.disconnect();}});
async function setup(t,apiMode='chat_completions',failure=null){
 const id=crypto.randomUUID(),modelId='xlsx-'+id;
 const user=await models.User.create({email:id+'@example.test',name:'Xlsx integration',status:'active',appTokens:100000});
 await models.ChatModels.create({modelId,enabled:true,inputPerM:.1,outputPerM:.2,apiMode,...(apiMode==='responses'?{reasoningEffort:'low'}:{})});
 const conversation=await models.ChatConversation.create({user:user.id,modelId});
 const original=await store.create({user:user.id,name:'source.xlsx',mimetype:require('../../src/services/files/office').mimes.xlsx,buffer:input});
 const payload={clientMessageId:crypto.randomUUID(),conversationId:conversation.id,modelId,message:'Multiply B2:B10001 by 2, keep all formulas and other content. Return edited copy.',files:[{fileId:original.id,storage:'private'}]};
 let calls=0;const usage={prompt_tokens:100,completion_tokens:20,total_tokens:120};
 const makeCall=()=>{
  calls++;assert.ok(calls<=2,'No provider call during background processing or recovery');
  const call={id:'action-'+calls,type:'function',function:calls===1?{name:'inspect_xlsx',arguments:JSON.stringify({fileId:original.id,sheet:'Дані',range:'A2:E10001',where:null,offset:0})}:{name:'edit_xlsx',arguments:JSON.stringify({fileId:original.id,sourceChecksum:book.checksum,filename:'edited.xlsx',selectionId:selection.id,expectedRows:10000,operations:[{column:'B',type:'multiply',value:2,expected:null}]})}};
  return call;
 };
 t.mock.method(Completions.prototype,'create',req=>{
  assert.equal(apiMode,'chat_completions');const call=makeCall();
  if(req.stream)return(async function*(){yield {choices:[{delta:{tool_calls:[{...call,index:0}]},finish_reason:'tool_calls'}],usage};})();
  return Promise.resolve({choices:[{message:{tool_calls:[call]},finish_reason:'tool_calls'}],usage});
 });
 t.mock.method(Responses.prototype,'create',async function*(){assert.equal(apiMode,'responses');const call=makeCall(),id='resp-'+calls;
  if(calls===2&&failure==='http')throw Object.assign(Error('Rejected'),{status:400,code:'invalid_request_error'});
  yield {type:'response.created',response:{id}};
  if(calls===2&&failure==='eof')return;
  if(calls===2&&failure==='incomplete'){yield {type:'response.incomplete',response:{id,status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[],usage:{input_tokens:50,output_tokens:2048,total_tokens:2098}}};return;}
  yield {type:'response.completed',response:{id,status:'completed',output:[{id:'fc-'+calls,type:'function_call',call_id:call.id,name:call.function.name,arguments:call.function.arguments,status:'completed'}],usage:{input_tokens:100,output_tokens:20,total_tokens:120}}};});
 if(failure==='budget')t.mock.method(require('../../src/services/computation/accounting'),'begin',async()=>{throw Object.assign(Error('Budget refused'),{fileError:'COMPUTE_BUDGET_LIMIT'});});
 const admitted=await accept({userId:user.id,payload}),claimed=await worker.claimTurn(admitted.turn.turnId);await worker.processTurn(claimed);
 const turn=await models.ChatTurn.findById(claimed.turn._id);
 if(!failure){assert.equal(turn.status,'processing');assert.equal(turn.computeState.documentJob.active,true);assert.equal(calls,2);}
 return {user,original,turn,payload,calls:()=>calls};
}
test('diagnostic report reads an existing XLSX turn without mutations or provider calls',opts,async t=>{
 const ctx=await setup(t,'responses');
 const before=(await models.ChatTurn.findById(ctx.turn._id)).toObject();
 const {execFileSync}=require('node:child_process');
 const output=execFileSync(process.execPath,['scripts/diagnoseDocumentTurn.js','--turn-id',ctx.turn.turnId],
  {cwd:require('node:path').join(__dirname,'../..'),env:{...process.env,MONGO_URI:uri},encoding:'utf8',timeout:20000});
 const report=JSON.parse(output);assert.equal(report.readOnly,true);assert.equal(report.reports.length,1);
 assert.equal(report.configurationSource,'diagnostic-process');
 assert.deepEqual(report.reports[0].workerRuntime,require('../../src/services/chatDeliveryV2/runtime'));
 assert.equal(report.reports[0].turnId,ctx.turn.turnId);assert.equal(report.reports[0].files[0].xlsx,true);
 assert.equal(report.reports[0].jobs.length,1);assert.equal(report.reports[0].jobs[0].status,'queued');
 assert.doesNotMatch(output,/example\.test|mongodb:|Multiply B2|source\.xlsx/);
 assert.deepEqual((await models.ChatTurn.findById(ctx.turn._id)).toObject(),before);assert.equal(ctx.calls(),2);
 // Drain this fixture after the read-only assertion so the next test's runOnce
 // cannot accidentally claim our older queued job.
 await queue.runOnce();await worker.recoverExpired();
 assert.equal((await models.ChatTurn.findById(ctx.turn._id)).status,'completed');
});
for(const failure of ['budget','http','incomplete','eof'])test(`Responses ${failure} after XLSX inspection retains exact failure and settles only confirmed usage`,opts,async t=>{
 const ctx=await setup(t,'responses',failure);
 assert.equal(await Job.countDocuments({turnId:ctx.turn.turnId}),0);
 const uncertain=failure==='eof';
 assert.equal(ctx.turn.status,uncertain?'failed':'completed');
 assert.equal(ctx.turn.needsReconciliation,uncertain);
 assert.equal(ctx.turn.reservationState,uncertain?'held':'settled');
 const expected={budget:'COMPUTE_BUDGET_LIMIT',http:'PROVIDER_REQUEST_REJECTED',incomplete:'PROVIDER_RESPONSE_INCOMPLETE',eof:'PROVIDER_STREAM_INTERRUPTED'};
 assert.equal(ctx.turn.failureDiagnostic.code,expected[failure]);
 if(uncertain){
  assert.equal(ctx.turn.failureDiagnostic.terminal.source,'worker.failTurn');
  assert.equal(ctx.turn.failureDiagnostic.terminal.recovery,false);
  assert.deepEqual(ctx.turn.failureDiagnostic.terminal.runtime,require('../../src/services/chatDeliveryV2/runtime'));
 }
 if(!uncertain){
  const msg=await models.ChatMessage.findById(ctx.turn.assistantMessage);
  assert.equal(msg.computation.status,'partial');assert.equal(msg.computation.reason,expected[failure]);assert.equal(msg.attachments.length,0);
  assert.equal(ctx.turn.usage.totalTokens,failure==='incomplete'?2218:120);
  assert.equal((await models.User.findById(ctx.user.id)).reservedAppTokens,0);
 }
 await worker.recoverExpired();await worker.recoverExpired();
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:ctx.turn.turnId}),uncertain?0:1);
 assert.equal(ctx.calls(),failure==='budget'?1:2);
});
test('an active document job cannot be failed by the chat worker after handoff',opts,async t=>{
 const ctx=await setup(t),before=ctx.turn.toObject();
 await worker.failTurn(ctx.turn,null,require('../../src/services/chatDeliveryV2/protocol').errorFor('PROCESS_INTERRUPTED'),{expiredOnly:true});
 assert.deepEqual((await models.ChatTurn.findById(ctx.turn._id)).toObject(),before);
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:ctx.turn.turnId}),0);
 await queue.runOnce();await worker.recoverExpired();await worker.recoverExpired();
 const turn=await models.ChatTurn.findById(ctx.turn._id);
 assert.equal(turn.status,'completed');assert.equal(turn.computeState.documentJob.report.processedRows,10000);
 assert.equal(turn.computeState.documentJob.report.changed,10000);assert.equal(ctx.calls(),2);
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:turn.turnId}),1);
});

for(const knownUsage of [false,true])test(`a stale recovery candidate cannot close an active document job (known usage: ${knownUsage})`,opts,async t=>{
 const ctx=await setup(t),stale=ctx.turn.toObject();
 // The initial scan is not the authority for the final write. Simulate a stale
 // candidate with the same attempt/lease; the persisted handoff must win.
 if(knownUsage)delete stale.computeState.documentJob;else stale.computeState=null;
 const mock=t.mock.method(models.ChatTurn,'find',async()=>[stale]);
 await worker.recoverExpired();mock.mock.restore();
 const live=await models.ChatTurn.findById(ctx.turn._id);
 assert.equal(live.status,'processing');assert.equal(live.providerResult,null);
 assert.equal(live.computeState.documentJob.active,true);assert.equal(live.reservationState,'held');
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:live.turnId}),0);
 await queue.runOnce();await worker.recoverExpired();
 assert.equal((await models.ChatTurn.findById(live._id)).status,'completed');assert.equal(ctx.calls(),2);
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:live.turnId}),1);
});

test('completion cannot charge an active document job even if given a live chat lease',opts,async t=>{
 const ctx=await setup(t),token=crypto.randomUUID();
 await models.ChatTurn.updateOne({_id:ctx.turn._id},{$set:{leaseToken:token,leaseUntil:new Date(Date.now()+30000)}});
 await assert.rejects(worker.commitCompletion(ctx.turn,token,'Premature completion',ctx.turn.computeState.usage),e=>e.staleLease===true);
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:ctx.turn.turnId}),0);
 assert.equal((await models.ChatTurn.findById(ctx.turn._id)).reservationState,'held');
 await models.ChatTurn.updateOne({_id:ctx.turn._id},{$set:{leaseToken:null,leaseUntil:new Date(0)}});
 await queue.runOnce();await worker.recoverExpired();
 assert.equal((await models.ChatTurn.findById(ctx.turn._id)).status,'completed');assert.equal(ctx.calls(),2);
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:ctx.turn.turnId}),1);
});

test('10000 rows: crash after durable chunk, two competing workers, restart and one final charge',opts,async t=>{
 const ctx=await setup(t),real=processXlsx.run;let failed=false;
 const mock=t.mock.method(processXlsx,'run',async(buffer,action,args,options)=>{
  if(action!=='chunks'||failed)return real(buffer,action,args,options);
  return real(buffer,action,args,{...options,onChunk:async c=>{await options.onChunk(c);if(c.processed===1500){failed=true;throw Object.assign(Error(),{fileError:'DOCUMENT_WORKER_CRASH'});}}});
 });
 await queue.runOnce();const paused=await Job.findOne({turnId:ctx.turn.turnId});assert.equal(paused.cursor,1500);assert.equal(paused.status,'queued');assert.equal(paused.chunks,3);
 assert.equal(await Chunk.countDocuments({job:paused._id}),3);assert.equal((await Quota.findById(ctx.user.id)).bytes,input.length+paused.stagedBytes);
 await worker.recoverExpired();assert.equal((await models.ChatTurn.findById(ctx.turn._id)).status,'processing');assert.equal(await models.ChatBillingLedger.countDocuments({turnId:ctx.turn.turnId}),0);
 mock.mock.restore();await Job.updateOne({_id:paused._id},{$set:{notBefore:new Date(0)}});
 await Promise.all([queue.runOnce(),queue.runOnce()]);assert.equal((await Job.findById(paused._id)).status,'ready');
 await worker.recoverExpired();await worker.recoverExpired();const completed=await models.ChatTurn.findById(ctx.turn._id);
 assert.equal(completed.status,'completed');assert.equal(completed.reservationState,'settled');assert.equal(ctx.calls(),2);assert.equal(await models.ChatBillingLedger.countDocuments({turnId:ctx.turn.turnId}),1);
 const message=await models.ChatMessage.findById(completed.assistantMessage);assert.equal(message.attachments.length,1);
 const result=await store.read(ctx.user.id,message.attachments[0].fileId);assert.equal(result.file.retention,'library');assert.equal(result.file.documentEdit.changed,10000);
 const b=engine.load(result.buffer),s=engine.sheetData(b,'Дані');for(const i of [1499,1500,1501,10000]){const r=s.rows[i];assert.equal(engine.cells(b,s.xml.slice(r.start,r.end),r.r).get(2).value,(i+.125)*2);}
 assert.equal(await Chunk.countDocuments({job:paused._id}),0);assert.equal((await Quota.findById(ctx.user.id)).bytes,input.length+result.buffer.length);
 assert.equal((await models.User.findById(ctx.user.id)).reservedAppTokens,0);assert.deepEqual((await store.read(ctx.user.id,ctx.original.id)).buffer,input);
 assert.equal((await accept({userId:ctx.user.id,payload:ctx.payload})).disposition,'duplicate');assert.equal(ctx.calls(),2);
});
test('cancellation persists without an active chat worker; saved usage settles once and no copy is exposed',opts,async t=>{
 const ctx=await setup(t);await cancel({turnId:ctx.turn.turnId,userId:ctx.user.id});await queue.runOnce();await worker.recoverExpired();
 const turn=await models.ChatTurn.findById(ctx.turn._id),job=await Job.findOne({turnId:turn.turnId});
 assert.equal(job.status,'cancelled');assert.equal(turn.status,'completed');assert.equal(turn.reservationState,'settled');assert.ok(turn.cancelRequestedAt);
 const message=await models.ChatMessage.findById(turn.assistantMessage);assert.equal(message.computation.reason,'USER_CANCELLED');assert.equal(message.attachments.length,0);
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:turn.turnId}),1);assert.equal((await Quota.findById(ctx.user.id)).bytes,input.length);assert.equal(ctx.calls(),2);
});
test('source deletion during a paused job cleans chunks and releases staging quota',opts,async t=>{
 const ctx=await setup(t),real=processXlsx.run;
 const mock=t.mock.method(processXlsx,'run',(buffer,action,args,options)=>real(buffer,action,args,{...options,onChunk:async c=>{await options.onChunk(c);throw Object.assign(Error(),{fileError:'DOCUMENT_WORKER_CRASH'});}}));
 await queue.runOnce();mock.mock.restore();await store.remove(ctx.user.id,ctx.original.id);await Job.updateOne({turnId:ctx.turn.turnId},{$set:{notBefore:new Date(0)}});
 await queue.runOnce();await worker.recoverExpired();const job=await Job.findOne({turnId:ctx.turn.turnId});assert.equal(job.status,'failed');assert.equal(job.errorCode,'FILE_NOT_FOUND');
 assert.equal(await Chunk.countDocuments({job:job._id}),0);assert.equal((await Quota.findById(ctx.user.id)).bytes,0);assert.equal(ctx.calls(),2);
});


test('Responses API hands off durably and status/F5 restores progress without paid continuation',opts,async t=>{
 const ctx=await setup(t,'responses');
 const before=await require('../../src/services/chatDeliveryV2/snapshot').snapshot(ctx.turn);
 assert.equal(before.computationStatus.job.state,'queued');assert.equal(before.computationStatus.job.total,10000);
 assert.equal(before.computationStatus.job.processed,0);assert.equal(before.computationStatus.job.id,undefined);
 await queue.runOnce();await worker.recoverExpired();const turn=await models.ChatTurn.findById(ctx.turn._id);
 assert.equal(turn.status,'completed');assert.equal(ctx.calls(),2);assert.equal(turn.usage.totalTokens,240);
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:turn.turnId}),1);
 const restored=await require('../../src/services/chatDeliveryV2/snapshot').snapshot(turn);
 assert.equal(restored.computationStatus,null);assert.equal(restored.assistantMessage.attachments.length,1);
});

test('expired worker lease is reclaimed; a stale worker cannot checkpoint or publish',opts,async t=>{
 const ctx=await setup(t),job=await Job.findOne({turnId:ctx.turn.turnId}).lean();
 await Job.updateOne({_id:job._id},{$set:{status:'running',leaseToken:'dead-worker',leaseUntil:new Date(0)}});
 const c=[...engine.chunks(book,job.plan,job.selection)][0];c.hash=engine.hash(c.xml);
 await assert.rejects(queue.checkpoint(job,'dead-worker',[],c),e=>e.staleLease===true);
 assert.equal(await Chunk.countDocuments({job:job._id}),0);
 await queue.runOnce();await worker.recoverExpired();assert.equal((await models.ChatTurn.findById(ctx.turn._id)).status,'completed');
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:ctx.turn.turnId}),1);assert.equal(ctx.calls(),2);
});

test('quota failure rolls back a chunk, releases staging and settles only known provider usage',opts,async t=>{
 const ctx=await setup(t);await Quota.updateOne({_id:ctx.user.id},{$set:{bytes:require('../../src/services/files/config').quotaBytes()}});
 await queue.runOnce();await worker.recoverExpired();const job=await Job.findOne({turnId:ctx.turn.turnId});
 assert.equal(job.status,'failed');assert.equal(job.errorCode,'FILE_QUOTA_EXCEEDED');assert.equal(job.stagedBytes,0);assert.equal(await Chunk.countDocuments({job:job._id}),0);
 const turn=await models.ChatTurn.findById(ctx.turn._id);assert.equal(turn.status,'completed');assert.equal(turn.reservationState,'settled');assert.equal(ctx.calls(),2);
});

test('SIGKILL of the actual worker process recovers committed chunks after lease expiry',opts,async t=>{
 const ctx=await setup(t);
 const child=require('node:child_process').fork(require.resolve('./fixtures/crashWorker'),[],{stdio:['ignore','ignore','ignore','ipc']});
 t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');});
 await new Promise((resolve,reject)=>{
  let saved=false;const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Crash fixture timed out'));},30000);
  child.on('message',message=>{if(message==='checkpoint-committed'){saved=true;child.kill('SIGKILL');}else{clearTimeout(timer);reject(Error('Worker finished before crash'));}});
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('exit',(_,signal)=>{clearTimeout(timer);if(saved&&signal==='SIGKILL')resolve();else reject(Error('Worker exited before durable checkpoint'));});
 });
 const abandoned=await Job.findOne({turnId:ctx.turn.turnId});assert.equal(abandoned.status,'running');assert.equal(abandoned.cursor,1000);
 assert.equal(await Chunk.countDocuments({job:abandoned._id}),2);
 // Advance expired leases in the test instead of waiting 90 real seconds.
 await Job.updateOne({_id:abandoned._id},{$set:{leaseUntil:new Date(0)}});
 await JobLease.updateMany({token:abandoned.leaseToken},{$set:{until:new Date(0)}});
 await queue.runOnce();await worker.recoverExpired();const turn=await models.ChatTurn.findById(ctx.turn._id);
 assert.equal(turn.status,'completed');assert.equal(turn.computeState.documentJob.report.changed,10000);assert.equal(turn.computeState.documentJob.report.chunks,20);
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:turn.turnId}),1);assert.equal(ctx.calls(),2);
 const job=await Job.findById(abandoned._id);assert.equal(job.stagedBytes,0);assert.equal(await Chunk.countDocuments({job:job._id}),0);
});
