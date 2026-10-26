const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
process.env.OPENAI_API_KEY||='mock-not-a-key';process.env.PRIVATE_FILES_ENABLED='true';process.env.OCR_ENABLED='false';
const mongoose=require('mongoose'),models=require('../../src/models');
const File=require('../../src/models/managedFile'),Quota=require('../../src/models/fileQuota'),Chunk=require('../../src/models/fileChunk');
const store=require('../../src/services/files/store'),input=require('../../src/services/files/zipInput'),codec=require('../../src/services/files/zipCodec');
const accept=require('../../src/services/chatDeliveryV2/acceptTurn'),worker=require('../../src/services/chatDeliveryV2/worker');
const {snapshot}=require('../../src/services/chatDeliveryV2/snapshot');
const {Completions}=require('openai/resources/chat/completions');
const uri=process.env.FILES_TEST_MONGO_URI,opts={skip:!uri};
const usage={prompt_tokens:100,completion_tokens:30,total_tokens:130};
let server,base;
test.before(async()=>{
 if(!uri)return;if(!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri))throw Error('Dedicated test DB required');
 await mongoose.connect(uri);for(const m of [...Object.values(models),File,Quota,Chunk])await m.createIndexes();
 test.mock.method(require('../../src/services/tokenLedger'),'notifyCommitted',()=>{});
 test.mock.method(Completions.prototype,'create',()=>{throw Error('Unexpected paid provider call');});
 // Exercise the real authenticated file router, using a deterministic auth stand-in.
 test.mock.method(require('../../src/middlewares'),'auth',async(req,res,next)=>{
  const id=req.headers['x-test-user'];if(!mongoose.isValidObjectId(id))return res.sendStatus(401);
  const user=await models.User.findById(id);if(!user)return res.sendStatus(401);req.user=user;next();
 });
 const app=require('express')();app.use('/files',require('../../src/routes/files'));
 await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});base=`http://127.0.0.1:${server.address().port}`;
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));if(uri){await mongoose.connection.dropDatabase();await mongoose.disconnect();}});
async function fixture(model={}){
 const id=crypto.randomUUID(),modelId=`zip-${id}`;
 const user=await models.User.create({email:`${id}@example.test`,name:'ZIP test',status:'active',appTokens:100000});
 await models.ChatModels.create({modelId,enabled:true,inputPerM:1,outputPerM:2,...model});
 const conversation=await models.ChatConversation.create({user:user.id,modelId});
 const file=await store.create({user:user.id,name:'inputs.zip',mimetype:'application/zip',buffer:codec.write([{path:'folder/data.csv',buffer:Buffer.from('name,value\nМарія,42')}])});
 const payload={clientMessageId:crypto.randomUUID(),conversationId:conversation.id,modelId,message:'Read ZIP and return results in a ZIP',files:[{fileId:file.id,storage:'private'}]};
 return {user,modelId,conversation,file,payload};
}
const request=(f,path,options={})=>fetch(base+path,{...options,headers:{'x-test-user':f.user.id,...options.headers}});
function provider(t){let calls=0;t.mock.method(Completions.prototype,'create',async function*(req){
 calls++;assert.match(JSON.stringify(req.messages),/Марія/);assert.match(JSON.stringify(req.messages),/folder\/data.csv/);
 const args=JSON.stringify({filename:'results.zip',content:JSON.stringify({files:[{path:'result.txt',content:'Марія: 42'},{path:'data.json',content:'{"value":42}'}]}),summary:'Results archive'});
 yield {choices:[{delta:{tool_calls:[{index:0,function:{name:'create_file',arguments:args}}]},finish_reason:'tool_calls'}],usage};
});return ()=>calls;}
test('prepare is private/idempotent, preview lists contents, derived quota reclaimed once on delete/expiry',opts,async()=>{
 const f=await fixture(),other=await fixture();
 const prepare=()=>request(f,`/files/${f.file.id}/prepare`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({modelId:f.modelId})});
 const responses=await Promise.all([prepare(),prepare()]);for(const r of responses){assert.equal(r.status,200);assert.equal((await r.json()).processing.method,'zip');}
 const file=await File.findById(f.file.id),quota=await Quota.findById(f.user.id);assert.ok(file.derivedBytes>0);assert.equal(quota.bytes,file.size+file.derivedBytes);
 const foreign=await request(other,`/files/${f.file.id}/preview`);assert.equal(foreign.status,404);
 const preview=await (await request(f,`/files/${f.file.id}/preview`)).json();assert.equal(preview.kind,'archive');assert.equal(preview.entries[0].path,'folder/data.csv');assert.equal(preview.entries[0].content,undefined);
 assert.equal((await request(f,`/files/${f.file.id}/download`)).status,200);
 await store.remove(f.user.id,f.file.id);await store.remove(f.user.id,f.file.id);assert.equal((await Quota.findById(f.user.id)).bytes,0);assert.equal((await File.findById(f.file.id)).zipCache,null);
 const expired=await fixture();await input.prepare(expired.user.id,expired.file.id,{});await File.updateOne({_id:expired.file.id},{$set:{expiresAt:new Date(0)}});await store.cleanup();assert.equal((await Quota.findById(expired.user.id)).bytes,0);
});
test('V2 transmits extracted ZIP, reserves its context, creates one ZIP and restores references after recovery',opts,async t=>{
 const f=await fixture();const calls=provider(t);const admitted=await accept({userId:f.user.id,payload:f.payload});assert.ok(admitted.turn.reservedAppTokens>10);
 const claim=await worker.claimTurn(admitted.turn.turnId);await worker.processTurn(claim);await worker.recoverExpired();
 const row=await models.ChatTurn.findById(claim.turn._id).lean();assert.equal(row.status,'completed');assert.equal(row.reservationState,'settled');assert.equal(calls(),1);
 const dto=await snapshot(row);assert.equal(dto.assistantMessage.attachments[0].mimetype,'application/zip');
 const result=await store.read(f.user.id,dto.assistantMessage.attachments[0].fileId);assert.equal(codec.read(result.buffer).length,2);
 assert.equal(await models.TokenOperation.countDocuments({'context.turnId':row.turnId,'entries.delta':{$lt:0}}),1);
 assert.equal((await models.User.findById(f.user.id)).reservedAppTokens,0);
 assert.equal((await accept({userId:f.user.id,payload:f.payload})).disposition,'duplicate');
 const next={...f.payload,clientMessageId:crypto.randomUUID(),message:'Compare the previous archive',files:[]};
 const second=await accept({userId:f.user.id,payload:next});const secondClaim=await worker.claimTurn(second.turn.turnId);await worker.processTurn(secondClaim);assert.equal(calls(),2);
});
test('invalid and opted-out ZIP creates no turn/reserve; foreign access cannot prepare',opts,async()=>{
 const disabled=await fixture({zipInputEnabled:false});await assert.rejects(accept({userId:disabled.user.id,payload:disabled.payload}),e=>e.fileError==='ZIP_INPUT_DISABLED');
 assert.equal(await models.ChatTurn.countDocuments({user:disabled.user.id}),0);assert.equal((await models.User.findById(disabled.user.id)).reservedAppTokens,0);
 const f=await fixture(),foreign=await fixture();await assert.rejects(input.prepare(foreign.user.id,f.file.id,{}),e=>e.fileError==='FILE_NOT_FOUND');
 const bad=await store.create({user:f.user.id,name:'bad.zip',mimetype:'application/zip',buffer:codec.write([{path:'app.exe',buffer:Buffer.from('MZ')}])});
 await assert.rejects(accept({userId:f.user.id,payload:{...f.payload,files:[{fileId:bad.id,storage:'private'}]}}),e=>e.fileError==='ZIP_UNSUPPORTED_ENTRY');assert.equal(await models.ChatTurn.countDocuments({user:f.user.id}),0);
 const outputDisabled=await fixture({zipOutputEnabled:false});await assert.rejects(accept({userId:outputDisabled.user.id,payload:{...outputDisabled.payload,outputFile:{filename:'out.zip'}}}),e=>e.protocolError?.code==='ZIP_OUTPUT_DISABLED');
});
test('saved ZIP provider result recovers without another model call or duplicate artifact/charge',opts,async t=>{
 const f=await fixture();const a=await accept({userId:f.user.id,payload:f.payload}),claim=await worker.claimTurn(a.turn.turnId);
 await models.ChatTurn.updateOne({_id:claim.turn._id},{$set:{leaseUntil:new Date(0),providerStartedAt:new Date(),providerResult:{assistantText:'Archive',usage:{promptTokens:100,completionTokens:30,totalTokens:130},artifact:{filename:'out.zip',content:JSON.stringify({files:[{path:'answer.txt',content:'saved'}]}),summary:'Archive'}}}});
 let calls=0;t.mock.method(Completions.prototype,'create',()=>{calls++;throw Error('Must not replay');});await worker.recoverExpired();await worker.recoverExpired();
 const row=await models.ChatTurn.findById(claim.turn._id).lean();assert.equal(row.status,'completed');assert.equal(calls,0);assert.equal(await File.countDocuments({user:f.user.id,source:'generated'}),1);assert.equal(await models.ChatBillingLedger.countDocuments({turnId:row.turnId}),1);
});
