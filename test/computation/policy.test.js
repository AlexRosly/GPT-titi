const test=require('node:test'),assert=require('node:assert/strict');
const p=require('../../src/services/computation/policy'),{estimate}=require('../../src/services/computation/budget');
const code=JSON.stringify({code:'print(1+1)',fileIds:[],exports:[]});
test('old/new models default on only after server enables isolated runtime; independent opt-out',()=>{
 const old={...process.env};try{process.env.PRIVATE_FILES_ENABLED='true';delete process.env.COMPUTE_V2_ENABLED;assert.equal(p.enabled({}),false);process.env.COMPUTE_V2_ENABLED='true';assert.equal(p.enabled({}),true);assert.equal(p.enabled({computationEnabled:false}),false);assert.equal(p.enabled(null),false);assert.equal(p.enabled({fileOutputEnabled:false}),true);}finally{process.env=old;}
});
test('bounded tool contract refuses paths, duplicate exports, extra fields and unknown formats',()=>{
 assert.equal(p.parse(code).code,'print(1+1)');
 for(const v of [{code:'x',fileIds:['bad'],exports:[]},{code:'x',fileIds:[],exports:[{path:'../out',filename:'a.csv'}]},{code:'x',fileIds:[],exports:[{path:'out',filename:'a.exe'}]},{code:'x',fileIds:[],exports:[],url:'http://example.com'},{code:'x'.repeat(33000),fileIds:[],exports:[]}])assert.throws(()=>p.parse(JSON.stringify(v)));
 const c=p.collector();c.add({choices:[{delta:{tool_calls:[{index:0,id:'a',function:{name:'run_python',arguments:code.slice(0,12)}}]}}]});c.add({choices:[{delta:{tool_calls:[{index:0,function:{arguments:code.slice(12)}}]},finish_reason:'tool_calls'}]});assert.equal(c.finish().function.arguments,code);
 const bad=p.collector();bad.add({choices:[{delta:{tool_calls:[{index:1,id:'a',function:{name:'run_python',arguments:code}}]},finish_reason:'length'}]});assert.throws(()=>bad.finish());
});
test('budget includes history, tools, images and bounded output; configuration is capped',()=>{
 const pricing={inputPerM:1,outputPerM:2,tokenValueUsd:0.000001};
 const simple=estimate([{role:'user',content:'Calculate 2+2'}],[],pricing);
 const more=estimate([{role:'system',content:'Instructions'},{role:'user',content:'History'.repeat(100)},{role:'user',content:[{type:'image_url',image_url:{url:'private'}}]}],[p.tool],pricing);
 assert.ok(more.amount>simple.amount);assert.equal(simple.outputTokens,2048);assert.ok(simple.usd>=2048*2/1e6);
 assert.throws(()=>estimate([],[],{...pricing,tokenValueUsd:0}));
 process.env.COMPUTE_MAX_RUNS='6';assert.throws(()=>p.limits());delete process.env.COMPUTE_MAX_RUNS;
});
test('sandbox has no host mounts, secrets, network or elevated capabilities',()=>{
 const a=require('../../src/services/computation/session').args('test',p.limits());
 for(const flag of ['--network=none','--read-only','--user=10001:10001','--memory=512m','--memory-swap=512m','--cpus=1','--pids-limit=64','--cap-drop=ALL','--security-opt=no-new-privileges','--log-driver=none'])assert.ok(a.includes(flag));
 assert.ok(!a.includes('--privileged'));assert.ok(!a.includes('-v'));assert.ok(!a.some(s=>s.includes('docker.sock')));
});
test('computation reservations use a separate idempotent ledger identity through call six',async t=>{
 const ledger=require('../../src/services/tokenLedger'),{TokenOperation}=require('../../src/models');let key;
 t.mock.method(TokenOperation,'findOne',q=>{key=q.key;return {session:()=>({lean:async()=>({_id:'receipt',kind:'reservation_hold',status:'confirmed',entries:[{user:'owner',delta:0,balance:100,balanceVersion:1}]})})};});
 const r=await ledger.increaseComputationReservation({userId:'owner',amount:5,turnId:'turn',attempt:2,phase:6,session:{}});
 assert.equal(r.alreadyApplied,true);assert.equal(key,'reservation_hold:computation:turn:2:6');
 assert.throws(()=>ledger.increaseComputationReservation({userId:'owner',amount:5,turnId:'turn',attempt:2,phase:7,session:{}}));
});
test('public progress/result metadata excludes code, stdout and private file paths',()=>{
 const status=require('../../src/services/computation/status');
 const state={stage:'executing',runs:2,calls:1,code:'secret',text:'private',files:[{path:'/private'}]};
 assert.deepEqual(status.progress({status:'processing',computeState:state}),{stage:'executing',runs:2,calls:1});
 assert.equal(status.progress({status:'completed',computeState:state}),null);
 assert.deepEqual(status.result({...state,status:'partial',executionMs:10,reason:'COMPUTE_TIMEOUT'}),{status:'partial',runs:2,executionMs:10,reason:'COMPUTE_TIMEOUT'});
});
