const test = require('node:test');
const assert = require('node:assert/strict');
const servicePath = require.resolve('../../src/services/files/deleteConversationFiles');
const calls=[];
require.cache[servicePath]={id:servicePath,filename:servicePath,loaded:true,exports:async(...args)=>{calls.push(args);if(args[1]==='busy')throw Object.assign(new Error(),{fileError:'CHAT_BUSY_STOP_BEFORE_DELETE',status:409});return {success:true,deletedFiles:args[2]?2:0};}};
const controller=require('../../src/controllers/chat/conversation/archiveConversation');
const run=async(query,id='chat')=>{let status,body;await controller({query,params:{id},user:{id:'owner'}},{status(s){status=s;return this},json(b){body=b;return this}});return {status,body};};
test('omitted and false flag preserve files for old clients and archive',async()=>{
 for(const query of [{},{deleteFiles:'false'}]){assert.equal((await run(query)).status,200);assert.equal(calls.at(-1)[2],false);}
});
test('true is forwarded with authenticated owner',async()=>{assert.equal((await run({deleteFiles:'true'})).body.deletedFiles,2);assert.deepEqual(calls.at(-1),['owner','chat',true]);});
test('malformed flags never invoke destructive service',async()=>{const n=calls.length;for(const v of ['1','TRUE','',true,['true'],{}])assert.equal((await run({deleteFiles:v})).status,400);assert.equal(calls.length,n);});
test('busy error is actionable and does not report success',async()=>{const r=await run({deleteFiles:'true'},'busy');assert.equal(r.status,409);assert.match(r.body.message,/Stop the active response/);});
