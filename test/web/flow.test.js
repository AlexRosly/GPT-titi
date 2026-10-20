const test=require('node:test'),assert=require('node:assert/strict');
const flow=require('../../src/services/web/flow'),policy=require('../../src/services/web/policy'),fetcher=require('../../src/services/web/fetch'),{ChatTurn}=require('../../src/models');
const response=indices=>({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'call_web',type:'function',function:{name:'read_webpage',arguments:JSON.stringify({indices})}}]}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
test('selection accepts only provided URL indices and complete, single calls',()=>{
 assert.deepEqual(flow.selection(response([0,1]),['https://a.com','https://b.com']).indices,[0,1]);
 for(const indices of [[3],[-1],[0,0],['0']])assert.throws(()=>flow.selection(response(indices),['https://a.com']),{webError:'WEB_INVALID_TOOL_RESULT'});
 const r=response([0]);r.choices[0].finish_reason='length';assert.throws(()=>flow.selection(r,['https://a.com']),{webError:'WEB_INVALID_TOOL_RESULT'});
});
test('checkpoints restore selected pages and usage without repeated selection or completed downloads',async t=>{
 const turn={_id:'id',user:'owner',attempt:1,modelId:'model',webPlan:policy.plan('https://example.com https://example.org',{},[],{})};
 let saved,calls=0,reads=0;
 t.mock.method(ChatTurn,'updateOne',async(filter,update)=>{assert.equal(filter.user,'owner');assert.equal(filter.leaseToken,'lease');saved=structuredClone(update.$set.webState);return {matchedCount:1};});
 const client={chat:{completions:{create:async()=>{calls++;return response([0,1]);}}}};
 t.mock.method(fetcher,'read',async url=>{reads++;return {url,title:'Page',text:'untrusted content',fetchedAt:'2026-01-01T00:00:00.000Z',truncated:false};});
 const opts={turn,leaseToken:'lease',model:{},messages:[{role:'user',content:'compare'}],client,signal:new AbortController().signal};
 const first=await flow.prepare(opts);assert.equal(calls,1);assert.equal(reads,2);assert.equal(first.usage.totalTokens,30);
 turn.webState=saved;const second=await flow.prepare(opts);assert.equal(calls,1);assert.equal(reads,2);assert.deepEqual(first.messages,second.messages);
 assert.equal(flow.sources(turn).length,2);assert.equal('text' in flow.sources(turn)[0],false);
 await flow.startFinal(turn,'lease');assert.equal(turn.webState.phase,'final_started');
 await assert.rejects(flow.prepare(opts),{webAmbiguous:true});
});
test('failed pages are disclosed as data; stale leases stop before retrieval',async t=>{
 const turn={_id:'id',user:'owner',attempt:1,modelId:'model',webPlan:policy.plan('http://127.0.0.1',{},[],{})};
 const opts={turn,leaseToken:'lease',model:{},messages:[],client:{chat:{completions:{create:async()=>response([0])}}},signal:new AbortController().signal};
 t.mock.method(ChatTurn,'updateOne',async()=>({matchedCount:1}));
 const r=await flow.prepare(opts);assert.match(r.messages[1].content,/WEB_BLOCKED_ADDRESS/);assert.equal(flow.footer(turn),'');
 turn.webState=null;t.mock.method(ChatTurn,'updateOne',async()=>({matchedCount:0}));await assert.rejects(flow.prepare(opts),{staleLease:true});
});
test('model opt-out prevents any selector request or cache resume',async()=>{
 const opts={turn:{webPlan:{urls:['https://example.com']}},model:{webInputEnabled:false}};
 await assert.rejects(flow.prepare(opts),{webError:'WEB_INPUT_DISABLED'});
});
test('before final request the actual combined content cannot exceed the reserved input bound',()=>{
 assert.throws(()=>flow.assertBudget({inputLimit:10},[{role:'user',content:'large input'}],[]),{webError:'WEB_CONTEXT_TOO_LARGE'});
 assert.deepEqual(flow.addUsage({promptTokens:20,completionTokens:10,totalTokens:30},{promptTokens:100,completionTokens:20,totalTokens:120}),{promptTokens:120,completionTokens:30,totalTokens:150});
});
