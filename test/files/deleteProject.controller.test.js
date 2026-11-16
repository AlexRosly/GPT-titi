const test=require('node:test');const assert=require('node:assert/strict');
const path=require.resolve('../../src/services/files/deleteProjectFiles');const calls=[];
require.cache[path]={id:path,filename:path,loaded:true,exports:async(...args)=>{calls.push(args);if(args[3]&&!args[2])throw Object.assign(Error(),{fileError:'INVALID_DELETE_OPTIONS',status:400});return {success:true};}};
const controller=require('../../src/controllers/projects/deleteProject');
const run=async query=>{let status=200,body;await controller({query,params:{id:'project'},user:{_id:'owner'}},{status(s){status=s;return this;},json(b){body=b;}});return {status,body};};
test('legacy project deletion keeps chats and files',async()=>{await run({});assert.deepEqual(calls.at(-1),['owner','project',false,false]);});
test('explicit choices pass through unchanged',async()=>{for(const f of ['true','false']){await run({deleteChats:'true',deleteFiles:f});assert.deepEqual(calls.at(-1),['owner','project',true,f==='true']);}});
test('reject malformed and contradictory choices',async()=>{for(const q of [{deleteChats:['true']},{deleteFiles:'1'},{deleteChats:'false',deleteFiles:'true'}])assert.equal((await run(q)).status,400);});
