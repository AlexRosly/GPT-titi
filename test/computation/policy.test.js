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

test('provider boundary distinguishes HTTP rejection, lazy rejection, partial output and local failures',async()=>{
 const {trackProviderStream}=require('../../src/services/chatDeliveryV2/providerStream');
 const error=Object.assign(new Error('rate limited'),{status:429});
 for(const lazy of [false,true]){
  const state={};
  const create=lazy?()=> (async function*(){throw error;})():async()=>{throw error;};
  await assert.rejects(async()=>{for await(const chunk of trackProviderStream(create,state))void chunk;},e=>e===error);
  assert.equal(state.rejectedBeforeOutput,true);
 }
 const partial={};
 await assert.rejects(async()=>{for await(const chunk of trackProviderStream(()=> (async function*(){yield {role:'assistant'};throw error;})(),partial))void chunk;});
 assert.equal(partial.rejectedBeforeOutput,false);
 const local={};
 await assert.rejects(async()=>{for await(const chunk of trackProviderStream(()=> (async function*(){yield {};})(),local)){void chunk;throw Object.assign(new Error('local validation'),{status:422});}});
 assert.equal(local.rejectedBeforeOutput,false);
 const empty={};for await(const chunk of trackProviderStream(()=> (async function*(){})(),empty))void chunk;
 assert.equal(empty.rejectedBeforeOutput,false);
});

test('execution policy separates PNG/multiple exports from create_file and respects output opt-out',()=>{
 const artifacts=require('../../src/services/files/artifacts');
 const description=artifacts.autoToolOptions({}).tools[0].function.description;
 assert.match(description,/restriction applies only to create_file/);
 assert.doesNotMatch(description,/Do not claim to create PNG/);
 const policy=p.instructions({});
 assert.match(policy,/every language/);
 assert.match(policy,/call run_python before reporting/);
 assert.match(policy,/actual PNG plots and multiple exports/);
 assert.match(policy,/export BOTH/);
 assert.match(policy,/without execution/);
 assert.match(policy,/Do not substitute a Python script/);
 const disabled=p.instructions({fileOutputEnabled:false});
 assert.match(disabled,/exports: \[\]/);assert.doesNotMatch(disabled,/export BOTH/);
 // Prompt changes do not extend the create_file renderer's format permissions.
 assert.throws(()=>artifacts.outputSpec({filename:'plot.png'}));
});
test('availability gives a bounded reason for runtime, model and request exclusions',()=>{
 const old={...process.env};try{
 process.env.PRIVATE_FILES_ENABLED='true';process.env.COMPUTE_V2_ENABLED='true';
 assert.equal(p.availability({}),'AVAILABLE');
 assert.equal(p.availability({computationEnabled:false}),'MODEL_OPT_OUT');
 assert.equal(p.availability(null),'MODEL_NOT_FOUND');
 assert.equal(p.availability({},{outputFile:{filename:'x.txt'}}),'EXPLICIT_FILE_MODE');
 assert.equal(p.availability({},{webPlan:{}}),'WEB_MODE');
 process.env.COMPUTE_V2_ENABLED='false';assert.equal(p.availability({}),'COMPUTE_DISABLED');
 process.env.COMPUTE_V2_ENABLED='true';process.env.PRIVATE_FILES_ENABLED='false';assert.equal(p.availability({}),'PRIVATE_FILES_DISABLED');
 }finally{process.env=old;}
});

test('export paths accept only a basename or exact output prefix; normalized aliases cannot duplicate',()=>{
 const action=path=>JSON.stringify({code:'print(1)',fileIds:[],exports:[{path,filename:'plot.png'}]});
 for(const path of ['plot.png','/work/output/plot.png'])assert.equal(p.parse(action(path)).exports[0].path,'plot.png');
 for(const path of ['/etc/passwd','/work/output/../secret','/work/output//plot.png','/work/output/sub/plot.png','/work/output/./plot.png','/work/output/','/work/output2/plot.png','output/plot.png','C:\\plot.png','/work/output/plot.png\n','/work/output/%2e%2e','/work/output/a\u0000.png','a..png'])assert.throws(()=>p.parse(action(path)),e=>e.computeReason==='EXPORT_PATH',path);
 assert.throws(()=>p.parse(JSON.stringify({code:'x',fileIds:[],exports:[{path:'plot.png',filename:'a.png'},{path:'/work/output/plot.png',filename:'b.png'}]})),e=>e.computeReason==='DUPLICATE_EXPORT');
 assert.throws(()=>p.parse(JSON.stringify({code:'x',fileIds:[],exports:[{path:'a',filename:'same.png'},{path:'b',filename:'SAME.PNG'}]})),e=>e.computeReason==='DUPLICATE_EXPORT');
});
test('rejection diagnostics expose only correlation and fixed reason, never raw action',t=>{
 let captured;t.mock.method(console,'warn',(...args)=>{captured=args;});
 let error;try{p.parse(JSON.stringify({code:'PRIVATE CODE',fileIds:[],exports:[{path:'/private/SECRET',filename:'secret.png'}]}));}catch(e){error=e;}
 p.diagnose(error,{turnId:'turn',attempt:1},'agent');
 assert.deepEqual(captured,['COMPUTE_ACTION_REJECTED',{turnId:'turn',attempt:1,stage:'agent',reason:'EXPORT_PATH'}]);
 assert.doesNotMatch(JSON.stringify(captured),/PRIVATE|SECRET|secret.png/);
});


test('compute budget defaults to 20 cents, honors lower overrides and refuses higher caps',()=>{
 const old=process.env.COMPUTE_MAX_USD;
 try {
  delete process.env.COMPUTE_MAX_USD;
  assert.equal(p.limits().usd,0.20);
  const priced=estimate([{role:'user',content:'Create XLSX and PNG'}],[p.tool],{inputPerM:5,outputPerM:30,tokenValueUsd:0.00001});
  assert.ok(priced.usd>0.05);assert.ok(priced.usd<0.20);
  for(const value of ['0.05','0.20']){process.env.COMPUTE_MAX_USD=value;assert.equal(p.limits().usd,Number(value));}
  for(const value of ['0.201','1','0','NaN','Infinity']){process.env.COMPUTE_MAX_USD=value;assert.throws(()=>p.limits(),e=>e.fileError==='COMPUTE_CONFIGURATION_ERROR');}
 }finally{if(old===undefined)delete process.env.COMPUTE_MAX_USD;else process.env.COMPUTE_MAX_USD=old;}
});
