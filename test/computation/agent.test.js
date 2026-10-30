const test=require('node:test'),assert=require('node:assert/strict');
process.env.PRIVATE_FILES_ENABLED='true';process.env.COMPUTE_V2_ENABLED='true';
const {ChatTurn}=require('../../src/models'),File=require('../../src/models/managedFile');
const store=require('../../src/services/files/store'),io=require('../../src/services/computation/files');
const accounting=require('../../src/services/computation/accounting'),runtime=require('../../src/services/computation/session');
const leases=require('../../src/services/computation/leases'),agent=require('../../src/services/computation/agent');
const usage={promptTokens:20,completionTokens:10,totalTokens:30};
function fixture(t){
 const turn={_id:'turn',turnId:'uuid',attempt:1,user:'owner',modelId:'test',pricing:{inputPerM:0.1,outputPerM:0.2,tokenValueUsd:0.000001}};
 let release=0,runs=0,creates=0;
 t.mock.method(ChatTurn,'updateOne',async(q,u)=>{if(u.$set?.computeState)turn.computeState=u.$set.computeState;return {matchedCount:1};});
 t.mock.method(ChatTurn,'findOne',()=>({session:async()=>turn}));
 t.mock.method(File,'updateOne',async()=>({matchedCount:1}));
 t.mock.method(store,'transaction',async fn=>fn({}));
 t.mock.method(store,'create',async f=>{creates++;return {_id:'012345678901234567890123',originalName:f.name,size:f.buffer.length};});
 t.mock.method(io,'inputs',async()=>[]);
 t.mock.method(leases,'acquire',async()=>async()=>{release++;});
 t.mock.method(runtime,'run',async()=>{runs++;return {ok:true,text:'6',truncated:false,exports:[{filename:'sum.csv',data:Buffer.from('sum\n6').toString('base64')}]};});
 t.mock.method(accounting,'begin',async()=>{turn.computeState={...turn.computeState,pending:true,calls:turn.computeState.calls+1};});
 t.mock.method(accounting,'received',async(_t,_token,u)=>{if(!u)throw Error('Unknown usage');const old=turn.computeState.usage;turn.computeState={...turn.computeState,pending:false,usage:{promptTokens:old.promptTokens+u.prompt_tokens,completionTokens:old.completionTokens+u.completion_tokens,totalTokens:old.totalTokens+u.total_tokens}};});
 const call={id:'one',type:'function',function:{name:'run_python',arguments:JSON.stringify({code:'print(6)',fileIds:[],exports:[{path:'sum',filename:'sum.csv'}]})}};
 const client={chat:{completions:{create:async()=>({choices:[{message:{content:'Sum = 6'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}}};
 const run=()=>agent.run(turn,'lease',{},[{role:'system',content:'help'},{role:'user',content:'sum'}],call,usage,[],client,new AbortController().signal);
 return {turn,client,run,call,stats:()=>({release,runs,creates})};
}
test('agent checkpoints outputs and aggregates known usage before returning attached results',async t=>{
 const f=fixture(t),r=await f.run();assert.equal(r.assistantText,'Sum = 6');assert.equal(r.usage.totalTokens,45);assert.equal(r.computation.files.length,1);assert.equal(r.computation.status,'completed');assert.deepEqual(f.stats(),{release:1,runs:1,creates:1});
});
test('ambiguous call is not replayed, pending is preserved and capacity is released',async t=>{
 const f=fixture(t);f.client.chat.completions.create=async()=>{throw Error('disconnect');};await assert.rejects(f.run());assert.equal(f.turn.computeState.pending,true);assert.equal(f.turn.computeState.calls,1);assert.equal(f.stats().release,1);
});
test('execution failures can be explained without fabricated files',async t=>{
 const f=fixture(t);t.mock.method(runtime,'run',async()=>({ok:false,text:'ValueError',exports:[],truncated:false}));const r=await f.run();assert.equal(r.computation.status,'partial');assert.equal(r.computation.files.length,0);assert.equal(f.stats().creates,0);
});
test('invalid tool input and a budget refusal stop before execution, retaining known usage',async t=>{
 const f=fixture(t);f.call.function.arguments='not json';const r=await f.run();assert.equal(r.computation.reason,'COMPUTE_INVALID_ACTION');assert.equal(f.stats().runs,0);assert.equal(r.usage.totalTokens,30);
});
test('unconfirmed container cleanup retains its distributed lease until expiry',async t=>{
 const f=fixture(t);t.mock.method(runtime,'run',async()=>{throw Object.assign(Error('cleanup'),{fileError:'COMPUTE_CLEANUP_PENDING',cleanupUnconfirmed:true});});const r=await f.run();assert.equal(r.computation.reason,'COMPUTE_CLEANUP_PENDING');assert.equal(f.stats().release,0);
});
test('a later run replaces its own staged filename instead of attaching duplicate versions',async t=>{
 const f=fixture(t);let removed=0,calls=0;t.mock.method(store,'remove',async()=>{removed++;});
 f.client.chat.completions.create=async()=>{calls++;return {choices:[calls===1?{message:{tool_calls:[{...f.call,id:'two'}]},finish_reason:'tool_calls'}:{message:{content:'Final result'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};};
 const r=await f.run();assert.equal(r.computation.files.length,1);assert.equal(r.computation.runs,2);assert.equal(removed,1);assert.equal(r.usage.totalTokens,60);
});

test('absolute sandbox export path reaches runtime as basename without rewriting Python code',async t=>{
 const f=fixture(t);const action=JSON.parse(f.call.function.arguments);
 action.code='print("/work/output/sum")';action.exports[0].path='/work/output/sum';
 f.call.function.arguments=JSON.stringify(action);let seen;
 t.mock.method(runtime,'run',async request=>{seen=request;return {ok:true,text:'6',truncated:false,exports:[{filename:'sum.csv',data:Buffer.from('sum\n6').toString('base64')}]};});
 const r=await f.run();assert.equal(r.computation.status,'completed');assert.equal(seen.exports[0].path,'sum');assert.equal(seen.code,action.code);assert.equal(f.stats().creates,1);
});
test('unsafe export path is diagnosed before runtime or follow-up provider call',async t=>{
 const f=fixture(t);let diagnostic,providerCalls=0;t.mock.method(console,'warn',(...args)=>{diagnostic=args;});
 f.client.chat.completions.create=async()=>{providerCalls++;throw Error('must not call');};
 f.call.function.arguments=JSON.stringify({code:'PRIVATE',fileIds:[],exports:[{path:'/work/output/../secret',filename:'secret.csv'}]});
 const r=await f.run();assert.equal(r.computation.reason,'COMPUTE_INVALID_ACTION');assert.equal(r.usage.totalTokens,30);assert.equal(f.stats().runs,0);assert.equal(f.stats().creates,0);assert.equal(providerCalls,0);assert.equal(diagnostic[1].reason,'EXPORT_PATH');
});
