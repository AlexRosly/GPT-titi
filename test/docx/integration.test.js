const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
process.env.OPENAI_API_KEY||='mock-not-a-key';process.env.PRIVATE_FILES_ENABLED='true';process.env.COMPUTE_V2_ENABLED='true';process.env.DOCX_EDIT_ENABLED='true';process.env.OCR_ENABLED='false';
const mongoose=require('mongoose'),models=require('../../src/models');
const File=require('../../src/models/managedFile'),Quota=require('../../src/models/fileQuota'),Chunk=require('../../src/models/fileChunk'),Lease=require('../../src/models/computationLease');
const store=require('../../src/services/files/store'),engine=require('../../src/services/docx/engine');
const accept=require('../../src/services/chatDeliveryV2/acceptTurn'),worker=require('../../src/services/chatDeliveryV2/worker');
const {Completions}=require('openai/resources/chat/completions');
const {fixture,table}=require('./fixtures');
const uri=process.env.FILES_TEST_MONGO_URI,opts={skip:!uri};
const usage={prompt_tokens:100,completion_tokens:30,total_tokens:130};
test.before(async()=>{if(!uri)return;if(!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri))throw Error('Dedicated test DB required');await mongoose.connect(uri);for(const m of [...Object.values(models),File,Quota,Chunk,Lease])await m.createIndexes();test.mock.method(require('../../src/services/tokenLedger'),'notifyCommitted',()=>{});test.mock.method(Completions.prototype,'create',()=>{throw Error('Unexpected paid call');});});
test.after(async()=>{if(uri){await mongoose.connection.dropDatabase();await mongoose.disconnect();}});
test('real V2 transaction stores original/copy/provenance, charges once and recovers without replay',opts,async t=>{
 const id=crypto.randomUUID(),modelId='docx-'+id,input=await fixture(table);
 const selection=engine.inspect(engine.load(input),'table0',0).selection;
 const user=await models.User.create({email:id+'@example.test',name:'Docx test',status:'active',appTokens:100000});
 await models.ChatModels.create({modelId,enabled:true,inputPerM:0.1,outputPerM:0.2});
 const conversation=await models.ChatConversation.create({user:user.id,modelId});
 const original=await store.create({user:user.id,name:'original.docx',mimetype:require('../../src/services/files/office').mimes.docx,buffer:input});
 const payload={clientMessageId:crypto.randomUUID(),conversationId:conversation.id,modelId,message:'Extend signature lines only',files:[{fileId:original.id,storage:'private'}]};
 const admitted=await accept({userId:user.id,payload}),claim=await worker.claimTurn(admitted.turn.turnId);let calls=0;
 t.mock.method(Completions.prototype,'create',req=>{
  calls++;assert.ok(calls<=2,'No concluding provider call');const call=calls===1?{id:'inspect',type:'function',function:{name:'inspect_docx',arguments:JSON.stringify({fileId:original.id,target:'table0',offset:0,query:null})}}:{id:'edit',type:'function',function:{name:'edit_docx',arguments:JSON.stringify({fileId:original.id,sourceChecksum:engine.hash(input),filename:'edited.docx',operations:[{type:'selection_border',selectionId:selection.id,expectedCells:3,side:'bottom',style:'single',size:4,color:'auto'}],complete:true})}};
  if(req.stream){assert.ok(req.tools.some(t=>t.function.name==='edit_docx'));return(async function*(){yield {choices:[{delta:{tool_calls:[{...call,index:0}]},finish_reason:'tool_calls'}],usage};})();}
  return Promise.resolve({choices:[calls===2?{message:{tool_calls:[call]},finish_reason:'tool_calls'}:{message:{content:'Edited copy attached.'},finish_reason:'stop'}],usage});
 });
 await worker.processTurn(claim);await worker.recoverExpired();
 const turn=await models.ChatTurn.findById(claim.turn._id);assert.equal(turn.status,'completed');assert.equal(turn.reservationState,'settled');assert.equal(calls,2);
 assert.deepEqual(turn.usage.toObject(),{promptTokens:200,completionTokens:60,totalTokens:260});
 assert.equal(turn.computeState.docxSelections[selection.id].fileId,original.id);
 assert.equal(turn.computeState.docxEdits[0].expandedOperationCount,3);
 const message=await models.ChatMessage.findById(turn.assistantMessage);assert.equal(message.computation.kind,'document');assert.equal(message.attachments.length,1);
 const output=await store.read(user.id,message.attachments[0].fileId);assert.equal(output.file.retention,'library');assert.equal(output.file.documentEdit.sourceFileId,original.id);assert.equal(output.file.documentEdit.requestedPropertiesVerified,true);
 assert.deepEqual((await store.read(user.id,original.id)).buffer,input);assert.equal(engine.load(output.buffer).byId.get('text0').text,'Посада');
 assert.equal((await Quota.findById(user.id)).bytes,input.length+output.buffer.length);
 assert.equal(await models.ChatBillingLedger.countDocuments({turnId:turn.turnId}),1);assert.equal((await models.User.findById(user.id)).reservedAppTokens,0);
 assert.equal((await accept({userId:user.id,payload})).disposition,'duplicate');assert.equal(calls,2);
});
