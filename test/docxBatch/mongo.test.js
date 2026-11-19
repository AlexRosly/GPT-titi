// Explicit server acceptance for both V2 provider protocols. The real worker being
// killed is a child Node process. It can only connect to the disposable test DB.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const uri=process.env.FILES_TEST_MONGO_URI;
const dbName=/^mongodb(?:\+srv)?:\/\/[^/?#]+\/(gptiti_files_test_[a-zA-Z0-9_-]+)(?:\?[^#]*)?$/.exec(uri||'')?.[1];
if(!dbName)throw Error('Set FILES_TEST_MONGO_URI to a disposable replica-set database named gptiti_files_test_*. This suite drops it.');
Object.assign(process.env,{MONGO_URI:uri,CHAT_RECONCILIATION_MONGO_URI:uri,OPENAI_API_KEY:'test-placeholder',PRIVATE_FILES_ENABLED:'true',COMPUTE_V2_ENABLED:'true',DOCUMENT_JOBS_ENABLED:'true',
  DOCX_EDIT_ENABLED:'true',DOCX_BATCH_ENABLED:'true',OCR_ENABLED:'false'});
const mongoose=require('mongoose'),models=require('../../src/models'),store=require('../../src/services/files/store');
const Job=require('../../src/models/documentJob'),Chunk=require('../../src/models/documentJobChunk'),Slots=require('../../src/models/documentJobLease');
const File=require('../../src/models/managedFile'),Quota=require('../../src/models/fileQuota');
const accept=require('../../src/services/chatDeliveryV2/acceptTurn'),worker=require('../../src/services/chatDeliveryV2/worker');
const {Completions}=require('openai/resources/chat/completions'),{Responses}=require('openai/resources/responses/responses');
const {fixture,oldText,newText}=require('./fixture'),managed=require('./pm2Harness'),engine=require('../../src/services/docxBatch/engine');
let owned=false;
test.before(async()=>{
  await mongoose.connect(uri,{autoCreate:false,autoIndex:false});
  assert.equal(mongoose.connection.name,dbName);
  if(await mongoose.connection.db.listCollections().hasNext())throw Error('The disposable test DB must be empty. Use a fresh gptiti_files_test_* database.');
  owned=true;
  for(const m of new Set([...Object.values(models),Job,Chunk,Slots,File,Quota,require('../../src/models/fileChunk'),require('../../src/models/computationLease')]))await m.createIndexes();
  test.mock.method(require('../../src/services/tokenLedger'),'notifyCommitted',()=>{});
});
test.after(async()=>{if(owned)await mongoose.connection.dropDatabase();await mongoose.disconnect();});
for(const [pages,mode] of [[5000,'chat_completions'],[10000,'responses']])test(pages+' rendered-page fixture, real Mongo, '+mode+', process restart, one stored file and charge',async t=>{
  const id=crypto.randomUUID(),modelId='docx-batch-'+id;
  const user=await models.User.create({email:id+'@example.test',name:'DOCX QA',status:'active',appTokens:100000});
  await models.ChatModels.create({modelId,enabled:true,inputPerM:.1,outputPerM:.2,apiMode:mode,...(mode==='responses'?{reasoningEffort:'low'}:{})});
  const chat=await models.ChatConversation.create({user:user.id,modelId}),source=await fixture(pages);
  const original=await store.create({user:user.id,name:'source.docx',mimetype:require('../../src/services/files/office').mimes.docx,buffer:source});
  const selected=engine.inspect(engine.load(source,oldText),oldText).selection;
  let calls=0;
  function tool(){
    assert.ok(++calls<=2,'unexpected provider replay');
    const inspect=calls===1;
    return {id:'call-'+calls,type:'function',function:{name:inspect?'inspect_docx_batch':'edit_docx_batch',arguments:JSON.stringify(inspect?
      {fileId:original.id,find:oldText}:{fileId:original.id,sourceChecksum:selected.sourceChecksum,selectionId:selected.id,expectedMatches:pages,value:newText,filename:'edited.docx'})}};
  }
  const usage={prompt_tokens:100,completion_tokens:20,total_tokens:120};
  t.mock.method(Completions.prototype,'create',req=>{
    assert.equal(mode,'chat_completions');const call=tool();assert.ok(req.tools.some(t=>t.function.name===call.function.name));
    if(req.stream)return(async function*(){yield {choices:[{delta:{tool_calls:[{...call,index:0}]},finish_reason:'tool_calls'}],usage};})();
    return Promise.resolve({choices:[{message:{tool_calls:[call]},finish_reason:'tool_calls'}],usage});
  });
  t.mock.method(Responses.prototype,'create',async function*(req){
    assert.equal(mode,'responses');const call=tool();assert.ok(req.tools.some(t=>t.name===call.function.name));
    yield {type:'response.completed',response:{id:'resp-'+calls,status:'completed',output:[{id:'fc-'+calls,type:'function_call',call_id:call.id,...call.function}],usage:{input_tokens:100,output_tokens:20,total_tokens:120}}};
  });
  const payload={clientMessageId:crypto.randomUUID(),conversationId:chat.id,modelId,message:'Replace every whole paragraph '+oldText+' with '+newText+'. Return the full edited DOCX.',files:[{fileId:original.id,storage:'private'}]};
  const admitted=await accept({userId:user.id,payload}),claim=await worker.claimTurn(admitted.turn.turnId);
  await worker.processTurn(claim);
  const turnId=admitted.turn.turnId;
  assert.equal((await Job.findOne({turnId})).adapter,'docx-text-v1');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gptiti-pm2-'));
  const isolated=managed('mongo',dir);
  t.after(async()=>{try{await isolated.close();}finally{await fs.rm(dir,{recursive:true,force:true});}});
  assert.equal(await isolated.first(),1500);
  const paused=await Job.findOne({turnId}).lean();
  assert.equal(paused.cursor,1500);assert.equal(paused.chunks,3);assert.equal(paused.status,'running');
  assert.equal(await Chunk.countDocuments({job:paused._id}),3);
  assert.equal(await models.ChatBillingLedger.countDocuments({turnId}),0);
  await worker.recoverExpired();
  const held=await models.ChatTurn.findOne({turnId});
  assert.equal(held.status,'processing');assert.equal(held.reservationState,'held');
  // Restart immediately; the new process polls the real queue until the old lease expires.
  const pids=await isolated.second();
  const ready=await Job.findOne({turnId}).lean();
  assert.equal(String(ready._id),String(paused._id));
  assert.equal(ready.status,'ready');assert.equal(ready.resumedFrom,1500);
  t.diagnostic(JSON.stringify({pages,jobId:String(ready._id),...pids,pausedAt:paused.cursor,resumedFrom:ready.resumedFrom,finalCursor:ready.cursor}));
  assert.equal(ready.chunks,pages*3/500);assert.equal(ready.changed,pages);
  assert.equal(await Chunk.countDocuments({job:ready._id}),0);
  await worker.recoverExpired();await worker.recoverExpired();
  const done=await models.ChatTurn.findOne({turnId});
  assert.equal(done.status,'completed');assert.equal(done.reservationState,'settled');
  assert.equal(done.computeState.documentJob.report.processedParagraphs,pages*3);
  assert.equal(done.computeState.documentJob.report.changed,pages);
  const message=await models.ChatMessage.findById(done.assistantMessage);
  assert.equal(message.attachments.length,1);
  const output=await store.read(user.id,message.attachments[0].fileId);
  assert.equal(output.file.retention,'library');
  assert.equal(engine.load(output.buffer,newText).matches.length,pages);
  assert.deepEqual((await store.read(user.id,original.id)).buffer,source);
  assert.equal(await File.countDocuments({user:user._id,source:'generated'}),1);
  assert.equal(await models.ChatBillingLedger.countDocuments({turnId}),1);
  assert.equal((await models.User.findById(user.id)).reservedAppTokens,0);
  assert.equal((await Quota.findById(user.id)).bytes,source.length+output.buffer.length);
  assert.equal((await accept({userId:user.id,payload})).disposition,'duplicate');assert.equal(calls,2);
});
