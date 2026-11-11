const test=require('node:test'),assert=require('node:assert/strict');
process.env.PRIVATE_FILES_ENABLED='true';process.env.COMPUTE_V2_ENABLED='true';process.env.DOCX_EDIT_ENABLED='true';
const {fixture,table,border}=require('./fixtures');
const {ChatTurn}=require('../../src/models'),store=require('../../src/services/files/store');
const engine=require('../../src/services/docx/engine'),policy=require('../../src/services/docx/policy'),action=require('../../src/services/docx/action');
const accounting=require('../../src/services/computation/accounting'),agent=require('../../src/services/computation/agent'),execute=require('../../src/services/computation/execute'),leases=require('../../src/services/computation/leases');
const realAccountingBegin=accounting.begin;
const sourceId='012345678901234567890123',resultId='012345678901234567890124';
const usage={promptTokens:20,completionTokens:10,totalTokens:30},providerUsage={prompt_tokens:10,completion_tokens:5,total_tokens:15};
const tool=(name,args,id='one')=>({id,type:'function',function:{name,arguments:JSON.stringify(name==='inspect_docx'?{query:null,...args}:args)}});
async function setup(t,body=table){
 const input=await fixture(body);let saved,creates=0;
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
 const edit=(complete=false)=>tool('edit_docx',{fileId:sourceId,sourceChecksum:engine.hash(input),filename:'edited.docx',operations:[border('cell0'),border('cell2')],complete},'two');
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
 await assert.rejects(execute.run({turn:f.turn,token:'lease',model:{},call:f.edit(true),available:f.available,transcript:[],initialUsage:usage,save:async s=>{f.turn.computeState=s;},signal:new AbortController().signal,completionAllowed:true}),{fileError:'FILE_QUOTA_EXCEEDED'});
 assert.deepEqual(f.turn.computeState.files,[]);assert.equal(f.turn.computeState.docxCompletion,undefined);assert.equal(engine.load(f.input).byId.get('text0').text,'Посада');
});
test('unchanged cost cap blocks the next paid call after a local inspection',async t=>{
 const f=await setup(t);f.turn.pricing={inputPerM:5,outputPerM:30,tokenValueUsd:0.00001};
 const old=process.env.COMPUTE_MAX_USD;process.env.COMPUTE_MAX_USD='0.001';t.after(()=>{if(old===undefined)delete process.env.COMPUTE_MAX_USD;else process.env.COMPUTE_MAX_USD=old;});
 // Exercise real accounting: budget refusal must occur at the paid boundary.
 t.mock.method(accounting,'begin',realAccountingBegin);
 t.mock.method(require('mongoose'),'startSession',async()=>({withTransaction:async fn=>fn(),endSession:async()=>{}}));
 let providerCalls=0;t.mock.method(console,'warn',()=>{});
 const client={chat:{completions:{create:async()=>{providerCalls++;throw Error('must not call');}}}};
 const r=await agent.run(f.turn,'lease',{},[],f.inspection,usage,f.available,client,new AbortController().signal);
 assert.equal(r.computation.reason,'COMPUTE_BUDGET_LIMIT');assert.equal(r.computation.runs,1);assert.equal(providerCalls,0);assert.equal(r.usage.totalTokens,30);assert.equal(f.stats().creates,0);
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

test('final verified Chat Completions edit returns without a concluding provider call',async t=>{
 const f=await setup(t);let calls=0;
 const client={chat:{completions:{create:async()=>{
  assert.equal(++calls,1,'a concluding paid call is forbidden');
  return {choices:[{message:{tool_calls:[f.edit(true)]},finish_reason:'tool_calls'}],usage:providerUsage};
 }}}};
 const r=await agent.run(f.turn,'lease',{},[],f.inspection,usage,f.available,client,new AbortController().signal);
 assert.equal(r.computation.status,'completed');assert.equal(r.usage.totalTokens,45);assert.equal(calls,1);
 assert.equal(r.computation.files.length,1);assert.match(r.assistantText,/Structural checks passed/);
 assert.equal(f.turn.computeState.docxCompletion.fileId,resultId);
});

test('final verified Responses edit returns without a concluding call and retains known usage',async t=>{
 const f=await setup(t);let requests=0;
 const calls=[f.inspection,f.edit(true)];
 const client={responses:{create:async function*(){
  assert.ok(requests<2,'a concluding paid call is forbidden');const c=calls[requests++];
  yield {type:'response.completed',response:{id:'resp_'+requests,status:'completed',output:[{id:'fc_'+c.id,type:'function_call',call_id:c.id,name:c.function.name,arguments:c.function.arguments,status:'completed'}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}};
 }}};
 const r=await require('../../src/services/chatDeliveryV2/responsesTurn').run({turn:f.turn,token:'lease',model:{apiMode:'responses',reasoningEffort:'low'},messages:[],fileTools:{tools:policy.tools},computeFiles:f.available,exactFiles:[],client,signal:new AbortController().signal,onText:async()=>{},save:async v=>Object.assign(f.turn,v),providerProgress:{}});
 assert.equal(requests,2);assert.equal(r.computation.status,'completed');assert.equal(r.usage.totalTokens,30);assert.equal(r.computation.files.length,1);
 assert.equal(f.turn.responseState.pending,false);assert.equal(f.turn.computeState.pending,false);
});

test('already planned local edit finishes near the cap without reserving a hypothetical future call',async t=>{
 const f=await setup(t);f.turn.pricing={inputPerM:5,outputPerM:30,tokenValueUsd:0.00001};
 f.turn.computeState={calls:1,pending:false,usage:{promptTokens:39820,completionTokens:10,totalTokens:39830},initialUsage:usage,runs:1,executionMs:0,files:[],docxInspections:{[sourceId]:engine.hash(f.input)}};
 t.mock.method(accounting,'begin',()=>{throw Error('Local edit cannot reserve a provider call');});
 const {next}=await execute.run({turn:f.turn,token:'lease',model:{},call:f.edit(true),available:f.available,transcript:[{role:'user',content:'large source '.repeat(10000)}],initialUsage:usage,save:async s=>{f.turn.computeState=s;},signal:new AbortController().signal,completionAllowed:true});
 assert.equal(next.calls,1);assert.equal(next.runs,2);assert.equal(next.files.length,1);assert.ok(next.docxCompletion);
});

test('rollback restores the old pre-worker budget refusal',async t=>{
 const f=await setup(t),old=process.env.DOCX_CONTINUATION_V2_ENABLED,oldCap=process.env.COMPUTE_MAX_USD;
 process.env.DOCX_CONTINUATION_V2_ENABLED='false';process.env.COMPUTE_MAX_USD='0.001';
 t.after(()=>{for(const [k,v] of [['DOCX_CONTINUATION_V2_ENABLED',old],['COMPUTE_MAX_USD',oldCap]])v===undefined?delete process.env[k]:process.env[k]=v;});
 f.turn.pricing={inputPerM:5,outputPerM:30,tokenValueUsd:0.00001};let actions=0;
 t.mock.method(action,'run',()=>{actions++;throw Error('must not run');});t.mock.method(console,'warn',()=>{});
 const r=await agent.run(f.turn,'lease',{},[],f.inspection,usage,f.available,{},new AbortController().signal);
 assert.equal(r.computation.reason,'COMPUTE_BUDGET_LIMIT');assert.equal(actions,0);
});

for(const api of ['chat_completions','responses'])test(`${api}: long multilingual DOCX fits unchanged cap with real budget accounting and bounded local tools`,async t=>{
 const mongoose=require('mongoose'),{User}=require('../../src/models'),ledger=require('../../src/services/tokenLedger');
 const sources=require('../../src/services/files/sourceParts'),textInput=require('../../src/services/files/textInput'),compute=require('../../src/services/computation/policy');
 const estimate=require('../../src/services/computation/budget').estimate;
 const raw='Код A-073; 数量 12,50; العربية; 日本語; 한국어; Ελληνικά; ґрунт.\n'.repeat(450);
 const f=await setup(t,raw.trim().split('\n').map(require('./fixtures').p).join('')+table);
 const part=sources.mark(textInput.part({originalName:'source.docx'},raw),{_id:sourceId,originalName:'source.docx',mimetype:require('../../src/services/files/office').mimes.docx});
 const messages=[{role:'system',content:policy.instructions},{role:'user',content:[{type:'text',text:'Change only signature borders. Preserve every name and amount.'},part]}];
 const original=JSON.stringify(messages);
 f.turn.pricing={inputPerM:5,outputPerM:30,tokenValueUsd:0.00001};f.turn.reservedAppTokens=100000;
 // This is the spent amount from the reported refusal. It is simulated usage,
 // not a claim about actual live provider token counts after compaction.
 const measuredUsage={prompt_tokens:8549,completion_tokens:0,total_tokens:8549};
 assert.ok(estimate(messages,compute.toolsFor({}),f.turn.pricing).usd+0.042745>0.20);
 t.mock.method(accounting,'begin',realAccountingBegin);
 t.mock.method(mongoose,'startSession',async()=>({withTransaction:async fn=>fn(),endSession:async()=>{}}));
 t.mock.method(User,'findById',()=>({session:()=>({lean:async()=>({status:'active',appTokens:200000,reservedAppTokens:100000})})}));
 t.mock.method(ledger,'notifyCommitted',()=>{});
 let requests=0;
 const inspectIndex=tool('inspect_docx',{fileId:sourceId,target:'tables',offset:0},'index');
 const inspectTable=tool('inspect_docx',{fileId:sourceId,target:'table0',offset:0},'details');
 const modelMessages=[];
 const nextCall=()=>requests===(api==='responses'?2:1)?inspectTable:f.edit(true);
 let result;
 if(api==='chat_completions'){
  const client={chat:{completions:{create:async req=>{
   requests++;assert.ok(requests<=2);modelMessages.push(req.messages);
   assert.doesNotMatch(JSON.stringify(req.messages),/END_ATTACHED_FILE_DATA/);
   assert.match(JSON.stringify(req.messages),/Change only signature borders/);
   return {choices:[{message:{tool_calls:[nextCall()]},finish_reason:'tool_calls'}],usage:measuredUsage};
  }}}};
  result=await agent.run(f.turn,'lease',{},messages,inspectIndex,usage,f.available,client,new AbortController().signal);
 }else{
  const client={responses:{create:async function*(req){
   requests++;assert.ok(requests<=3);modelMessages.push(req.input);
   if(requests>1){assert.doesNotMatch(JSON.stringify(req.input),/END_ATTACHED_FILE_DATA/);assert.ok(req.input.some(i=>i.type==='reasoning'&&i.encrypted_content==='opaque-reasoning-1'));}
   const c=requests===1?inspectIndex:nextCall();
   yield {type:'response.completed',response:{id:'resp_'+requests,status:'completed',output:[{type:'reasoning',id:'r'+requests,encrypted_content:'opaque-reasoning-'+requests},{id:'fc_'+c.id,type:'function_call',call_id:c.id,name:c.function.name,arguments:c.function.arguments,status:'completed'}],usage:requests===1?{input_tokens:20,output_tokens:10,total_tokens:30}:{input_tokens:8549,output_tokens:0,total_tokens:8549}}};
  }}};
  result=await require('../../src/services/chatDeliveryV2/responsesTurn').run({turn:f.turn,token:'lease',model:{apiMode:'responses',reasoningEffort:'low'},messages,fileTools:{tools:compute.toolsFor({})},computeFiles:f.available,exactFiles:[],client,signal:new AbortController().signal,onText:async()=>{},save:async v=>Object.assign(f.turn,v),providerProgress:{}});
 }
 assert.equal(result.computation.status,'completed');assert.equal(result.computation.runs,3);assert.equal(result.computation.files.length,1);
 assert.equal(f.turn.computeState.calls,2);assert.equal(f.turn.computeState.pending,false);assert.equal(result.usage.totalTokens,30+8549*2);
 assert.equal(JSON.stringify(messages),original);assert.equal(f.stats().creates,1);
});

test('Responses never short-circuits a group containing another outstanding tool action',async t=>{
 const f=await setup(t);let requests=0;
 const client={responses:{create:async function*(req){
  requests++;const calls=requests===1?[f.inspection]:requests===2?[f.edit(true),tool('inspect_docx',{fileId:sourceId,target:'tables',offset:0},'three')]:[];
  if(requests===3){const outputs=req.input.filter(i=>i.type==='function_call_output');assert.equal(outputs.length,3);}
  yield {type:'response.completed',response:{id:'resp_'+requests,status:'completed',output:calls.length?calls.map(c=>({id:'fc_'+c.id,type:'function_call',call_id:c.id,name:c.function.name,arguments:c.function.arguments,status:'completed'})):[{type:'message',content:[{type:'output_text',text:'All requested actions processed.'}]}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}};
 }}};
 const r=await require('../../src/services/chatDeliveryV2/responsesTurn').run({turn:f.turn,token:'lease',model:{apiMode:'responses',reasoningEffort:'low'},messages:[],fileTools:{tools:policy.tools},computeFiles:f.available,exactFiles:[],client,signal:new AbortController().signal,onText:async()=>{},save:async v=>Object.assign(f.turn,v),providerProgress:{}});
 assert.equal(requests,3);assert.equal(r.computation.runs,3);assert.equal(f.turn.computeState.docxCompletion,undefined);assert.equal(r.assistantText,'All requested actions processed.');
});

test('complete=true cannot turn a rejected edit into success',async t=>{
 const f=await setup(t);let calls=0;const bad=f.edit(true),args=JSON.parse(bad.function.arguments);args.operations[0].target='cell999';bad.function.arguments=JSON.stringify(args);
 const client={chat:{completions:{create:async()=>{
  calls++;return {choices:[calls===1?{message:{tool_calls:[bad]},finish_reason:'tool_calls'}:{message:{content:'The requested target was not found.'},finish_reason:'stop'}],usage:providerUsage};
 }}}};
 const r=await agent.run(f.turn,'lease',{},[],f.inspection,usage,f.available,client,new AbortController().signal);
 assert.equal(calls,2);assert.equal(r.computation.status,'partial');assert.equal(r.computation.reason,'DOCX_TARGET_NOT_FOUND');assert.equal(r.computation.files.length,0);assert.equal(f.turn.computeState.docxCompletion,undefined);
});

test('cancel after a final edit is verified but before its quota transaction publishes no output or completion marker',async t=>{
 const f=await setup(t),c=new AbortController();
 f.turn.computeState={calls:0,pending:false,usage,initialUsage:usage,runs:1,executionMs:0,files:[],docxInspections:{[sourceId]:engine.hash(f.input)}};
 t.mock.method(store,'transaction',async fn=>{c.abort();return fn({});});
 await assert.rejects(execute.run({turn:f.turn,token:'lease',model:{},call:f.edit(true),available:f.available,transcript:[],initialUsage:usage,save:async s=>{f.turn.computeState=s;},signal:c.signal,completionAllowed:true}));
 assert.equal(f.stats().creates,0);assert.equal(f.turn.computeState.docxCompletion,undefined);assert.deepEqual(f.turn.computeState.files,[]);
});

// Whole workflows: both cumulative input and NONZERO generated/reasoning output
// contribute at every paid boundary. No fixed 'already spent' benchmark shortcut.
for (const api of ['chat_completions','responses']) test(`${api}: cumulative budget covers batched 25-row selection and local range edit`, async t => {
 const {User}=require('../../src/models'),mongoose=require('mongoose'),ledger=require('../../src/services/tokenLedger');
 const compute=require('../../src/services/computation/policy'),office=require('../../src/services/files/office');
 const artifacts=require('../../src/services/files/artifacts'),textInput=require('../../src/services/files/textInput');
 const sources=require('../../src/services/files/sourceParts'),estimate=require('../../src/services/computation/budget').estimate;
 const enc=require('js-tiktoken').getEncoding('o200k_base');
 const body=Array.from({length:100},(_,i)=>require('./fixtures').p('Архівний текст '+i)).join('')+
  Array.from({length:5},()=>table.replace(/<w:tr>[\s\S]*<\/w:tr>/,table.match(/<w:tr>[\s\S]*<\/w:tr>/)[0].repeat(5))).join('');
 const f=await setup(t,body),raw=await require('../../src/services/files/officeInput').extract(f.input,'docx');
 const messages=[{role:'system',content:'You are a helpful assistant. '+textInput.instructions+' '+artifacts.fileSystemInstructions+' '+compute.instructions({})+' Office exports follow: '+office.instructions+'\nCOMPUTATION_FILES: '+JSON.stringify(f.available)+' '+policy.instructions},
  {role:'user',content:[{type:'text',text:'Apply a bottom border to all physical cells in all five tables. Keep every text and all other formatting.'},sources.mark(textInput.part({originalName:'source.docx'},raw),{_id:sourceId,originalName:'source.docx',mimetype:office.mimes.docx})]}];
 f.turn.pricing={inputPerM:5,outputPerM:30,tokenValueUsd:0.00001};f.turn.reservedAppTokens=100000;
 t.mock.method(mongoose,'startSession',async()=>({withTransaction:async fn=>fn(),endSession:async()=>{}}));
 t.mock.method(User,'findById',()=>({session:()=>({lean:async()=>({status:'active',appTokens:200000,reservedAppTokens:100000})})}));
 t.mock.method(ledger,'notifyCommitted',()=>{});
 const projections=[]; let currentBudget, requests=0, editing;
 t.mock.method(accounting,'begin',async(...args)=>{
  const st=f.turn.computeState;
  const spent=((st.usage.promptTokens-st.initialUsage.promptTokens)*5+(st.usage.completionTokens-st.initialUsage.completionTokens)*30)/1e6;
  currentBudget=await realAccountingBegin(...args);projections.push({spent,estimate:currentBudget.usd});return currentBudget;
 });
 const index=tool('inspect_docx',{fileId:sourceId,target:'tables',offset:0},'index');
 const target='table0,table1,table2,table3,table4';
 function choose(){
  requests++;
  if(requests===(api==='responses'?1:0))return index;
  if(requests===(api==='responses'?2:1))return tool('inspect_docx',{fileId:sourceId,target,offset:0},'tables');
  assert.equal(requests,api==='responses'?3:2,'No model call for paging or final narration');
  const s=Object.values(f.turn.computeState.docxSelections).find(s=>s.target===target);
  assert.equal(s.cellCount,75);assert.equal(f.turn.computeState.docxLastInspection.matching,25);
  assert.equal(f.turn.computeState.docxLastInspection.hasMore,false);
  editing=tool('edit_docx',{fileId:sourceId,sourceChecksum:engine.hash(f.input),filename:'range.docx',complete:true,
   operations:[{type:'selection_border',selectionId:s.id,expectedCells:s.cellCount,side:'bottom',style:'single',size:4,color:'auto'}]},'edit');return editing;
 }
 const allTools=[...artifacts.autoToolOptions({}).tools,...compute.toolsFor({})];
 const initialPrompt=estimate(messages,allTools,f.turn.pricing).promptTokens;
 const initial={promptTokens:initialPrompt,completionTokens:700,totalTokens:initialPrompt+700};
 function paidUsage(call){
  const prompt=currentBudget?.promptTokens??initialPrompt;
  const completion=512+enc.encode(JSON.stringify(call),[],[]).length;
  assert.ok(completion<=2048);return {prompt_tokens:prompt,completion_tokens:completion,total_tokens:prompt+completion};
 }
 let r;
 if(api==='chat_completions'){
  r=await agent.run(f.turn,'lease',{},messages,index,initial,f.available,{chat:{completions:{create:async()=>{
   const call=choose();return {choices:[{message:{tool_calls:[call]},finish_reason:'tool_calls'}],usage:paidUsage(call)};
  }}}},new AbortController().signal);
 }else{
  const client={responses:{create:async function*(){const call=choose(),u=paidUsage(call);
   yield {type:'response.completed',response:{id:'r'+requests,status:'completed',output:[{type:'function_call',id:'fc'+requests,call_id:call.id,name:call.function.name,arguments:call.function.arguments,status:'completed'}],usage:{input_tokens:u.prompt_tokens,output_tokens:u.completion_tokens,total_tokens:u.total_tokens}}};
  }}};
  r=await require('../../src/services/chatDeliveryV2/responsesTurn').run({turn:f.turn,token:'lease',model:{apiMode:'responses',reasoningEffort:'low'},messages,fileTools:{tools:allTools},computeFiles:f.available,exactFiles:[],client,signal:new AbortController().signal,onText:async()=>{},save:async v=>Object.assign(f.turn,v),providerProgress:{}});
 }
 assert.equal(r.computation.status,'completed');assert.equal(r.computation.runs,3);assert.equal(projections.length,2);
 assert.ok(projections[1].spent>0.02);assert.ok(projections.every(p=>p.spent+p.estimate<=0.2));
 const output=engine.load(f.stats().saved.buffer);
 assert.equal(f.stats().saved.documentEdit.expandedOperationCount,75);
 assert.equal((output.xml.match(/<w:bottom /g)||[]).length,75);
 assert.equal(f.stats().creates,1);assert.equal(r.computation.files.length,1);assert.equal(f.turn.computeState.pending,false);
});

test('saved range cannot cross file ownership, and a cancelled range publishes nothing',async t=>{
 const f=await setup(t),s=engine.inspect(engine.load(f.input),'table0',0).selection;
 const call=tool('edit_docx',{fileId:sourceId,sourceChecksum:engine.hash(f.input),filename:'range.docx',complete:true,
  operations:[{type:'selection_border',selectionId:s.id,expectedCells:3,side:'bottom',style:'single',size:4,color:'auto'}]});
 f.turn.computeState={usage,initialUsage:usage,runs:1,executionMs:0,files:[],docxInspections:{[sourceId]:engine.hash(f.input)},docxSelections:{[s.id]:{...s,fileId:resultId}}};
 await assert.rejects(action.run({turn:f.turn,model:{},call,available:f.available,signal:new AbortController().signal}),{fileError:'DOCX_SELECTION_REQUIRED'});
 f.turn.computeState.docxSelections[s.id].fileId=sourceId;
 const c=new AbortController();t.mock.method(store,'transaction',async fn=>{c.abort();return fn({});});
 await assert.rejects(execute.run({turn:f.turn,token:'lease',model:{},call,available:f.available,transcript:[],initialUsage:usage,save:async s=>{f.turn.computeState=s;},signal:c.signal,completionAllowed:true}));
 assert.equal(f.stats().creates,0);assert.equal(f.turn.computeState.docxCompletion,undefined);
});
