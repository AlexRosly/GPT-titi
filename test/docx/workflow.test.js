const test=require('node:test'),assert=require('node:assert/strict');
process.env.PRIVATE_FILES_ENABLED='true';process.env.COMPUTE_V2_ENABLED='true';process.env.DOCX_EDIT_ENABLED='true';
const {fixture,table,border}=require('./fixtures');
const {ChatTurn}=require('../../src/models'),store=require('../../src/services/files/store');
const engine=require('../../src/services/docx/engine'),policy=require('../../src/services/docx/policy'),action=require('../../src/services/docx/action');
const accounting=require('../../src/services/computation/accounting'),agent=require('../../src/services/computation/agent'),execute=require('../../src/services/computation/execute'),leases=require('../../src/services/computation/leases');
const sourceId='012345678901234567890123',resultId='012345678901234567890124';
const usage={promptTokens:20,completionTokens:10,totalTokens:30},providerUsage={prompt_tokens:10,completion_tokens:5,total_tokens:15};
const tool=(name,args,id='one')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
async function setup(t){
 const input=await fixture(table);let saved,creates=0;
 const turn={_id:'turn',turnId:'uuid',attempt:1,user:'owner',modelId:'test',pricing:{inputPerM:0.1,outputPerM:0.2,tokenValueUsd:0.00001}};
 const available=[{fileId:sourceId,name:'source.docx',size:input.length}];
 t.mock.method(store,'owned',async(user,id)=>{assert.equal(user,'owner');if(id!==sourceId)throw Object.assign(Error(),{fileError:'FILE_NOT_FOUND'});return {originalName:'source.docx',size:input.length};});
 t.mock.method(store,'read',async(user,id)=>{assert.equal(user,'owner');assert.equal(id,sourceId);return {buffer:input,file:{originalName:'source.docx'}};});
 t.mock.method(store,'transaction',async fn=>fn({}));
 t.mock.method(store,'create',async f=>{creates++;saved=f;return {_id:resultId,originalName:f.name,size:f.buffer.length};});
 t.mock.method(ChatTurn,'updateOne',async(q,u)=>{assert.equal(q.cancelRequestedAt,null);if(u.$set?.computeState)turn.computeState=u.$set.computeState;return {matchedCount:1};});
 t.mock.method(ChatTurn,'findOne',()=>({session:async()=>turn}));
 t.mock.method(leases,'acquire',async()=>async()=>{});
 t.mock.method(accounting,'begin',async()=>{turn.computeState.pending=true;turn.computeState.calls++;});
 t.mock.method(accounting,'received',async(_,__,u)=>{turn.computeState.pending=false;const old=turn.computeState.usage;turn.computeState.usage={promptTokens:old.promptTokens+u.prompt_tokens,completionTokens:old.completionTokens+u.completion_tokens,totalTokens:old.totalTokens+u.total_tokens};});
 const inspection=tool('inspect_docx',{fileId:sourceId,target:'table0',offset:0});
 const edit=()=>tool('edit_docx',{fileId:sourceId,sourceChecksum:engine.hash(input),filename:'edited.docx',operations:[border('cell0'),border('cell2')]},'two');
 return {turn,input,available,inspection,edit,stats:()=>({saved,creates})};
}
test('Chat Completions inspect/edit pipeline attaches a verified binary copy with known usage',async t=>{
 const f=await setup(t);let calls=0;
 const client={chat:{completions:{create:async req=>{
  calls++;assert.ok(req.tools.some(t=>t.function.name==='edit_docx'));
  return {choices:[calls===1?{message:{tool_calls:[f.edit()]},finish_reason:'tool_calls'}:{message:{content:'Edited copy attached; structural checks passed.'},finish_reason:'stop'}],usage:providerUsage};
 }}}};
 const r=await agent.run(f.turn,'lease',{},[{role:'user',content:'Extend signature lines only'}],f.inspection,usage,f.available,client,new AbortController().signal);
 assert.equal(r.computation.status,'completed');assert.equal(r.computation.kind,'document');assert.equal(r.computation.files[0].fileId,resultId);assert.equal(r.usage.totalTokens,60);
 const {saved,creates}=f.stats();assert.equal(creates,1);assert.equal(saved.retention,'temporary');assert.match(saved.resultKey,/:compute:2:0$/);assert.equal(saved.buffer.readUInt32LE(0),0x04034b50);
 assert.equal(engine.load(saved.buffer).byId.get('text0').text,'Посада');assert.equal(engine.hash(f.input),f.turn.computeState.docxEdits[0].sourceChecksum);
 assert.equal(f.turn.computeState.docxEdits[0].otherPartsByteIdentical,true);
});
test('Responses API uses the same real inspection/editor and preserves cumulative usage',async t=>{
 const f=await setup(t),requests=[];f.turn.modelId='test-responses';
 const calls=[f.inspection,f.edit()];
 const client={responses:{create:async function*(request){
  requests.push(request);const c=calls[requests.length-1];
  yield {type:'response.completed',response:{id:'resp_'+requests.length,status:'completed',output:c?[{id:'fc_'+c.id,type:'function_call',call_id:c.id,name:c.function.name,arguments:c.function.arguments,status:'completed'}]:[{type:'message',content:[{type:'output_text',text:'Edited file attached.'}]}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}};
 }}};
 const r=await require('../../src/services/chatDeliveryV2/responsesTurn').run({turn:f.turn,token:'lease',model:{apiMode:'responses',reasoningEffort:'low'},messages:[{role:'user',content:'Edit DOCX'}],fileTools:{tools:policy.tools,tool_choice:'auto'},computeFiles:f.available,exactFiles:[],client,signal:new AbortController().signal,onText:async()=>{},onResponseId:async()=>{},save:async v=>Object.assign(f.turn,v),providerProgress:{}});
 assert.equal(r.computation.status,'completed');assert.equal(r.computation.kind,'document');assert.equal(r.computation.files.length,1);assert.equal(r.usage.totalTokens,45);assert.equal(f.stats().creates,1);
});
test('inspection is mandatory; checksum drift, forbidden files and disabled models never publish',async t=>{
 const f=await setup(t);f.turn.computeState={docxInspections:{}};
 const params={turn:f.turn,model:{},call:f.edit(),available:f.available,signal:new AbortController().signal};
 await assert.rejects(action.run(params),{fileError:'DOCX_INSPECTION_REQUIRED'});
 f.turn.computeState.docxInspections[sourceId]='a'.repeat(64);const a=JSON.parse(params.call.function.arguments);a.sourceChecksum='a'.repeat(64);params.call=tool('edit_docx',a);
 await assert.rejects(action.run(params),{fileError:'DOCX_SOURCE_CHANGED'});
 await assert.rejects(action.run({...params,available:[]}),{fileError:'COMPUTE_FILE_FORBIDDEN'});
 await assert.rejects(action.run({...params,model:{fileOutputEnabled:false}}),{fileError:'DOCX_EDIT_DISABLED'});
 assert.equal(f.stats().creates,0);
});
test('cancellation before execution or before commit never publishes a partial DOCX',async t=>{
 const f=await setup(t),controller=new AbortController();controller.abort();
 await assert.rejects(action.run({turn:f.turn,model:{},call:f.inspection,available:f.available,signal:controller.signal}));
 const c=new AbortController();f.turn.computeState={usage,initialUsage:usage,runs:0,executionMs:0,files:[]};
 t.mock.method(action,'run',async()=>{c.abort();return {result:{ok:true},prepared:[{name:'edited.docx',buffer:f.input}],statePatch:{}};});
 await assert.rejects(execute.run({turn:f.turn,token:'lease',model:{},call:f.inspection,available:f.available,transcript:[],initialUsage:usage,save:async s=>{f.turn.computeState=s;},signal:c.signal}));assert.equal(f.stats().creates,0);
});
test('quota refusal preserves original and does not checkpoint a ready result',async t=>{
 const f=await setup(t);f.turn.computeState={usage,initialUsage:usage,runs:0,executionMs:0,files:[],docxInspections:{[sourceId]:engine.hash(f.input)}};
 t.mock.method(store,'create',async()=>{throw Object.assign(Error(),{fileError:'FILE_QUOTA_EXCEEDED'});});
 await assert.rejects(execute.run({turn:f.turn,token:'lease',model:{},call:f.edit(),available:f.available,transcript:[],initialUsage:usage,save:async s=>{f.turn.computeState=s;},signal:new AbortController().signal}),{fileError:'FILE_QUOTA_EXCEEDED'});
 assert.deepEqual(f.turn.computeState.files,[]);assert.equal(engine.load(f.input).byId.get('text0').text,'Посада');
});
test('unchanged cost cap blocks before inspection, without starting a document worker',async t=>{
 const f=await setup(t);f.turn.pricing={inputPerM:5,outputPerM:30,tokenValueUsd:0.00001};
 const old=process.env.COMPUTE_MAX_USD;process.env.COMPUTE_MAX_USD='0.001';t.after(()=>{if(old===undefined)delete process.env.COMPUTE_MAX_USD;else process.env.COMPUTE_MAX_USD=old;});
 let actions=0;t.mock.method(action,'run',async()=>{actions++;throw Error('must not execute');});t.mock.method(console,'warn',()=>{});
 const r=await agent.run(f.turn,'lease',{},[],f.inspection,usage,f.available,{},new AbortController().signal);
 assert.equal(r.computation.reason,'COMPUTE_BUDGET_LIMIT');assert.equal(actions,0);assert.equal(r.usage.totalTokens,30);
});
test('stream collector recognizes document tools; feature flag removes them without changing Python',()=>{
 const compute=require('../../src/services/computation/policy');const c=compute.collector();c.add({choices:[{delta:{tool_calls:[{index:0,id:'a',function:{name:'inspect_docx',arguments:'{}'}}]},finish_reason:'tool_calls'}]});assert.equal(c.finish().function.name,'inspect_docx');
 const old=process.env.DOCX_EDIT_ENABLED;delete process.env.DOCX_EDIT_ENABLED;try{assert.deepEqual(compute.toolsFor({}).map(t=>t.function.name),['run_python']);assert.equal(compute.accepts('edit_docx',{}),false);}finally{process.env.DOCX_EDIT_ENABLED=old;}
});
test('document worker cancellation releases capacity and output uses a distinct name',async t=>{
 const f=await setup(t),processDocx=require('../../src/services/docx/process');
 const c=new AbortController(),pending=processDocx.run(f.input,'inspect_docx',{target:'table0',offset:0},c.signal);
 c.abort();await assert.rejects(pending,{fileError:'COMPUTE_ABORTED'});
 const inspected=await processDocx.run(f.input,'inspect_docx',{target:'table0',offset:0},new AbortController().signal);
 assert.equal(inspected.inspection.checksum,engine.hash(f.input));
 f.turn.computeState={docxInspections:{[sourceId]:engine.hash(f.input)}};
 const args=JSON.parse(f.edit().function.arguments);args.filename='source.docx';
 await assert.rejects(action.run({turn:f.turn,model:{},call:tool('edit_docx',args),available:f.available,signal:new AbortController().signal}),{fileError:'DOCX_NEW_FILENAME_REQUIRED'});
});
test('failed edit remains a partial result with its precise failure code and no attachment',async t=>{
 const f=await setup(t);
 t.mock.method(action,'run',async()=>{throw Object.assign(Error(),{fileError:'DOCX_EDIT_UNSUPPORTED'});});
 const client={chat:{completions:{create:async()=>({choices:[{message:{content:'This edit is unsupported.'},finish_reason:'stop'}],usage:providerUsage})}}};
 const r=await agent.run(f.turn,'lease',{},[],f.inspection,usage,f.available,client,new AbortController().signal);
 assert.equal(r.computation.status,'partial');assert.equal(r.computation.reason,'DOCX_EDIT_UNSUPPORTED');assert.equal(r.computation.files.length,0);assert.equal(f.stats().creates,0);
});
