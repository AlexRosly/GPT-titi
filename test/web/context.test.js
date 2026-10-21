const test=require('node:test'),assert=require('node:assert/strict');
const {ChatTurn}=require('../../src/models');
const context=require('../../src/services/web/context'),reader=require('../../src/services/web/fetch');
const {fail}=require('../../src/services/web/policy');
const fixture=()=>({_id:'turn',user:'owner',attempt:1,webPlan:{version:2,urls:['https://example.com/','https://example.org/']}});
test.beforeEach(()=>{process.env.WEB_READING_V2_ENABLED='true';});
test.afterEach(()=>{delete process.env.WEB_READING_V2_ENABLED;});
test('checkpointed sources resume without rereading; private data is excluded from source DTOs',async t=>{
 const turn=fixture();let writes=0,reads=0;
 t.mock.method(ChatTurn,'updateOne',async(filter,update)=>{assert.equal(filter.user,'owner');assert.equal(filter.leaseToken,'lease');assert.equal(filter.providerStartedAt,null);assert.ok(update.$set.webState);writes++;return {matchedCount:1};});
 t.mock.method(reader,'read',async url=>{reads++;return {url,title:'Page',text:'Untrusted content',truncated:false};});
 const part=await context.prepare(turn,'lease',{},new AbortController().signal);
 assert.match(part.content,/Untrusted content/);assert.equal(reads,2);assert.equal(writes,4);
 await context.prepare(turn,'lease',{},new AbortController().signal);assert.equal(reads,2);
 const sources=context.sources(turn);assert.equal(sources.length,2);assert.equal(sources[0].text,undefined);
 assert.match(context.footer(turn),/https:\/\/example.com/);
});
test('partial reads disclose failures; all failed pages return an actionable error',async t=>{
 const turn=fixture();t.mock.method(ChatTurn,'updateOne',async()=>({matchedCount:1}));
 t.mock.method(reader,'read',async url=>{if(url.includes('example.org'))throw fail('WEB_TIMEOUT');return {url,title:'A',text:'A',truncated:true};});
 const part=await context.prepare(turn,'lease',{},new AbortController().signal);assert.match(part.content,/WEB_TIMEOUT/);
 assert.match(context.footer(turn),/partial page text/);assert.match(context.footer(turn),/WEB_TIMEOUT/);
 t.mock.method(reader,'read',async()=>{throw fail('WEB_ACCESS_DENIED');});
 await assert.rejects(context.prepare(fixture(),'lease',{},new AbortController().signal),{webError:'WEB_ACCESS_DENIED'});
});
test('opt-out, abort and stale lease prevent fetching any page',async t=>{
 let reads=0;t.mock.method(reader,'read',async()=>{reads++;});
 await assert.rejects(context.prepare(fixture(),'lease',{webInputEnabled:false},new AbortController().signal),{webError:'WEB_INPUT_DISABLED'});
 const aborted=new AbortController();aborted.abort(new Error('stop'));
 await assert.rejects(context.prepare(fixture(),'lease',{},aborted.signal),/stop/);
 t.mock.method(ChatTurn,'updateOne',async()=>({matchedCount:0}));
 await assert.rejects(context.prepare(fixture(),'lease',{},new AbortController().signal),{staleLease:true});assert.equal(reads,0);
});
