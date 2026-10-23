const test=require('node:test'), assert=require('node:assert/strict');
const {ChatTurn}=require('../../src/models');
const accounting=require('../../src/services/browser/accounting');
const sessions=require('../../src/services/browser/session');
const {run}=require('../../src/services/browser/agent');
const usage={prompt_tokens:10,completion_tokens:5,total_tokens:15};
function setup(t){
  process.env.BROWSER_V2_ENABLED='true';process.env.WEB_READING_V2_ENABLED='true';
  const turn={webPlan:{mode:'browser',urls:['https://example.com/']},modelId:'test',attempt:1};
  let actions=0,closed=0;
  t.mock.method(ChatTurn,'updateOne',async()=>({matchedCount:1}));
  t.mock.method(accounting,'begin',async t=>{t.browserState={...(t.browserState||{}),calls:(t.browserState?.calls||0)+1,pending:true,usage:t.browserState?.usage||{promptTokens:0,completionTokens:0,totalTokens:0}};return {};});
  t.mock.method(accounting,'received',async(t,u,usage)=>{const state=t.browserState;state.pending=false;state.usage={promptTokens:state.usage.promptTokens+usage.prompt_tokens,completionTokens:state.usage.completionTokens+usage.completion_tokens,totalTokens:state.usage.totalTokens+usage.total_tokens};});
  t.mock.method(accounting,'rejected',async t=>{t.browserState.pending=false;});
  t.mock.method(sessions,'create',()=>({close(){closed++;},async action(){actions++;return {url:'https://example.com/',title:'Fixture',text:'Actual page content',controls:[{ref:'b1',kind:'follow',url:'https://example.com/article'}]};}}));
  return {turn,actions:()=>actions,closed:()=>closed};
}
const choose=action=>({usage,choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'call1',type:'function',function:{name:'browse',arguments:JSON.stringify(action)}}]}}]});
const client=fn=>({chat:{completions:{create:fn}}});
const messages=[{role:'system',content:'Help.'},{role:'user',content:'Прочитай https://example.com/'}];
test('navigate then answer, aggregate actual usage and preserve visited sources without screenshots',async t=>{
  const f=setup(t);let calls=0;
  const result=await run(f.turn,'lease',{},messages,{},client(async req=>{
    calls++;if(calls===1)return choose({kind:'follow',ref:'b1'});if(calls===2)return choose({kind:'done'});
    assert.match(JSON.stringify(req.messages),/Actual page content/);return {usage,choices:[{finish_reason:'stop',message:{content:'Answer'}}]};
  }));
  assert.equal(result.assistantText,'Answer');assert.equal(result.usage.totalTokens,45);assert.equal(f.actions(),2);assert.equal(f.closed(),1);assert.equal(f.turn.webState.results.length,2);
});
test('known rejection after paid calls returns explicit incomplete result and preserves prior usage',async t=>{
  const f=setup(t);let calls=0;
  const result=await run(f.turn,'lease',{},messages,{},client(async()=>{if(++calls===1)return choose({kind:'done'});throw Object.assign(new Error(),{status:429});}));
  assert.equal(result.usage.totalTokens,15);assert.match(result.assistantText,/incomplete/);assert.equal(f.turn.browserState.pending,false);
});
test('ambiguous provider disconnect keeps pending boundary for reconciliation, never retries',async t=>{
  const f=setup(t);let calls=0;
  await assert.rejects(run(f.turn,'lease',{},messages,{},client(async()=>{calls++;throw new Error('disconnect');})));
  assert.equal(f.turn.browserState.pending,true);assert.equal(calls,1);assert.equal(f.closed(),1);
});
test('invalid action stops without executing it; consumed provider usage retained',async t=>{
  const f=setup(t);const result=await run(f.turn,'lease',{},messages,{},client(async()=>choose({kind:'click',selector:'#buy'})));
  assert.equal(f.actions(),1);assert.equal(result.usage.totalTokens,15);assert.match(result.assistantText,/BROWSER_INVALID_ACTION/);
});
test('insufficient first-call reserve prevents provider call and clears boundary',async t=>{
  const f=setup(t);t.mock.method(accounting,'begin',async()=>{throw Object.assign(new Error(),{protocolError:{code:'INSUFFICIENT_BALANCE'}});});
  let calls=0;await assert.rejects(run(f.turn,'lease',{},messages,{},client(async()=>{calls++;})));
  assert.equal(calls,0);assert.equal(f.turn.providerStartedAt,null);assert.equal(f.closed(),1);
});
test('vision is explicit capability; screenshots never persist in source metadata',async t=>{
  const f=setup(t);t.mock.method(sessions,'create',()=>({close(){},async action(a,v){assert.equal(v,true);return {url:'https://example.com/',text:'visible',controls:[],image:'abc'};}}));
  let calls=0;await run(f.turn,'lease',{browserVisionEnabled:true},messages,{},client(async req=>{if(++calls===1){assert.match(JSON.stringify(req.messages),/data:image\/jpeg/);return choose({kind:'done'});}return {usage,choices:[{finish_reason:'stop',message:{content:'Answer'}}]};}));
  assert.equal(f.turn.webState.results[0].image,undefined);
});
test('nullable model action navigates without another provider retry and persists safe diagnostics',async t=>{
  const f=setup(t);let calls=0;const events=[];
  t.mock.method(console,'info',(name,value)=>events.push({name,value}));
  const result=await run(f.turn,'lease',{},messages,{},client(async()=>{
    calls++;if(calls===1)return choose({kind:'follow',ref:'b1',query:null,url:null});
    if(calls===2)return choose({kind:'done',ref:null,query:null,url:null});
    return {usage,choices:[{finish_reason:'stop',message:{content:'Article summary'}}]};
  }));
  assert.equal(calls,3);assert.equal(f.actions(),2);assert.equal(result.usage.totalTokens,45);
  assert.equal(result.assistantText,'Article summary');assert.equal(events.length,2);
  assert.equal(f.turn.browserState.lastActionDiagnostic.reason,'ACCEPTED');
});
test('rejected argument records exact reason, bills consumed usage once and performs no extra action',async t=>{
  const f=setup(t);let calls=0;const events=[];t.mock.method(console,'warn',(name,value)=>events.push({name,value}));
  const result=await run(f.turn,'lease',{},messages,{},client(async()=>{calls++;return choose({kind:'done',query:'PRIVATE_SECRET'});}));
  assert.equal(calls,1);assert.equal(f.actions(),1);assert.equal(result.usage.totalTokens,15);
  assert.equal(f.turn.browserState.lastActionDiagnostic.reason,'UNUSED_ARGUMENT_NOT_EMPTY');
  assert.equal(events[0].name,'BROWSER_ACTION_REJECTED');assert.ok(!JSON.stringify(events).includes('PRIVATE_SECRET'));
  assert.equal(f.turn.browserState.pending,false);
});
test('failed second navigation summarizes saved text with one final call and keeps exact diagnostic',async t=>{
  const f=setup(t);let actions=0,calls=0;const logs=[];
  t.mock.method(console,'warn',(name,value)=>logs.push({name,value}));
  t.mock.method(sessions,'create',()=>({close(){},async action(){
    if (++actions===1) return {url:'https://example.com/',text:'VERIFIED_SAVED_TEXT',controls:[{ref:'b1',kind:'follow'}]};
    throw Object.assign(new Error('PRIVATE_SECRET'),{webError:'BROWSER_NAVIGATION_FAILED',browserSessionDiagnostic:{reason:'NAVIGATION_FAILED',stage:'navigate',actionIndex:2,message:'PRIVATE_SECRET'}});
  }}));
  const result=await run(f.turn,'lease',{},messages,{},client(async req=>{
    if (++calls===1) return choose({kind:'follow',ref:'b1'});
    assert.match(JSON.stringify(req.messages),/VERIFIED_SAVED_TEXT/);assert.equal(req.tools,undefined);assert.equal(req.tool_choice,undefined);
    return {usage,choices:[{finish_reason:'stop',message:{content:'Useful summary'}}]};
  }));
  assert.equal(calls,2);assert.equal(actions,2);assert.equal(result.usage.totalTokens,30);assert.equal(f.turn.webState.results.length,1);
  assert.match(result.assistantText,/Useful summary/);assert.match(result.assistantText,/incomplete/);
  assert.equal(f.turn.browserState.lastSessionDiagnostic.reason,'NAVIGATION_FAILED');assert.equal(f.turn.browserState.navigationIncomplete,true);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_SECRET'));
});
test('first page failure does not call the model or invent a summary',async t=>{
  const f=setup(t);let calls=0;
  t.mock.method(sessions,'create',()=>({close(){},async action(){throw Object.assign(new Error(),{webError:'BROWSER_TIMEOUT',browserSessionDiagnostic:{reason:'ACTION_TIMEOUT',stage:'navigate'}});}}));
  await assert.rejects(run(f.turn,'lease',{},messages,{},client(async()=>{calls++;})));
  assert.equal(calls,0);assert.equal(f.turn.providerStartedAt,null);
});
test('fallback provider uncertainty stays pending and is never retried',async t=>{
  const f=setup(t);let actions=0,calls=0;
  t.mock.method(sessions,'create',()=>({close(){},async action(){if(++actions===1)return {url:'https://example.com/',text:'saved',controls:[{ref:'b1',kind:'follow'}]};throw new Error('navigation');}}));
  await assert.rejects(run(f.turn,'lease',{},messages,{},client(async()=>{if(++calls===1)return choose({kind:'follow',ref:'b1'});throw new Error('provider disconnect');})));
  assert.equal(calls,2);assert.equal(f.turn.browserState.pending,true);
});
test('fallback reservation rejection makes no final provider call and retains paid usage',async t=>{
  const f=setup(t);let actions=0,calls=0;const begin=accounting.begin.bind(accounting);
  t.mock.method(accounting,'begin',async(...args)=>{if(f.turn.browserState?.calls===1)throw Object.assign(new Error(),{protocolError:{code:'INSUFFICIENT_BALANCE'}});return begin(...args);});
  t.mock.method(sessions,'create',()=>({close(){},async action(){if(++actions===1)return {url:'https://example.com/',text:'saved',controls:[{ref:'b1',kind:'follow'}]};throw new Error('navigation');}}));
  const result=await run(f.turn,'lease',{},messages,{},client(async()=>{calls++;return choose({kind:'follow',ref:'b1'});}));
  assert.equal(calls,1);assert.equal(result.usage.totalTokens,15);assert.equal(f.turn.browserState.pending,false);
});
test('expired lease after action failure prevents fallback provider call',async t=>{
  const f=setup(t);let actions=0,calls=0,stale=false;
  t.mock.method(ChatTurn,'updateOne',async()=>({matchedCount:stale?0:1}));
  t.mock.method(sessions,'create',()=>({close(){},async action(){
    if(++actions===1)return {url:'https://example.com/',text:'saved',controls:[{ref:'b1',kind:'follow'}]};
    stale=true;throw new Error('navigation');
  }}));
  await assert.rejects(run(f.turn,'lease',{},messages,{},client(async()=>{calls++;return choose({kind:'follow',ref:'b1'});})),e=>e.staleLease===true);
  assert.equal(calls,1);
});
test('parent abort prevents fallback and preserves previously billed usage',async t=>{
  const f=setup(t);let actions=0,calls=0;const controller=new AbortController();
  t.mock.method(sessions,'create',()=>({close(){},async action(){
    if(++actions===1)return {url:'https://example.com/',text:'saved',controls:[{ref:'b1',kind:'follow'}]};
    controller.abort();throw Object.assign(new Error(),{webError:'BROWSER_TIMEOUT'});
  }}));
  const result=await run(f.turn,'lease',{},messages,{},client(async()=>{calls++;return choose({kind:'follow',ref:'b1'});}),controller.signal);
  assert.equal(calls,1);assert.equal(result.usage.totalTokens,15);assert.match(result.assistantText,/incomplete/);
});
test('time budget stops planning early and answers without another navigation',async t=>{
  const f=setup(t);let calls=0,now=1000;t.mock.method(Date,'now',()=>now);
  const result=await run(f.turn,'lease',{},messages,{},client(async req=>{
    if(++calls===1){now+=110000;return choose({kind:'follow',ref:'b1'});}
    assert.equal(req.tools,undefined);return {usage,choices:[{finish_reason:'stop',message:{content:'Saved evidence'}}]};
  }));
  assert.equal(calls,2);assert.equal(f.actions(),1);assert.match(result.assistantText,/BROWSER_TIME_BUDGET/);
});
