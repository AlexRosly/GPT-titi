const test = require('node:test');
const assert = require('node:assert/strict');
const exact = require('../../src/services/files/exactTranscription');
const store = require('../../src/services/files/store');
const id = '123456789012345678901234';
const chunk = (name, args, finish = null, index = 0) => ({ choices: [{ delta: { tool_calls: [{ index, function: { name, arguments: args } }] }, finish_reason: finish }] });
test('transcription collector accepts split arguments and rejects multiple, truncated or injected selections', () => {
  const c = exact.collector(); c.add(chunk('show_saved_', '')); c.add(chunk('transcription', '{"fileIds":[')); c.add(chunk('', '"'+id+'"]}', 'tool_calls'));
  assert.deepEqual(c.finish().ids, [id]);
  for (const [args, reason, index] of [[JSON.stringify({fileIds:[id]}),'length',0], [JSON.stringify({fileIds:[id,id]}),'tool_calls',0], [JSON.stringify({fileIds:[id],text:'fake'}),'tool_calls',0], [JSON.stringify({fileIds:[id]}),'tool_calls',1]]) {
    const c=exact.collector();c.add(chunk(exact.NAME,args,reason,index));assert.equal(c.finish().error,true);
  }
  const normal=exact.collector(); normal.add({choices:[{delta:{content:'Summary'},finish_reason:'stop'}]});assert.equal(normal.finish(),null);
  const file=exact.collector();file.add(chunk('create_file','{}','tool_calls'));assert.equal(file.finish(),null);
});
test('server transcription preserves exact cache including numbers, scripts and fences; unknown/deleted/stale files never leak', async t => {
  const text='[PDF PAGE 1 OF 1 — OCR]\n4 462,64\n```\n<script>x</script>\nשלום';
  const f={id,name:'scan.pdf',text,checksum:'a'};
  const current={checksum:'a',ocrCache:{version:3,checksum:'a',text}};
  t.mock.method(store,'owned',async()=>current);
  const result=await exact.render('owner',{ids:[id]},[f]);
  assert.ok(result.includes('````text\n'+text+'\n````'));
  assert.equal(await exact.render('owner',{ids:['000000000000000000000000']},[f]),exact.failure);
  current.ocrCache.text='changed';assert.equal(await exact.render('owner',{ids:[id]},[f]),exact.failure);
  store.owned.mock.mockImplementation(async()=>{throw {fileError:'FILE_NOT_FOUND'};});assert.equal(await exact.render('owner',{ids:[id]},[f]),exact.failure);
});
test('tools default on for new models, honor input opt-outs and use frozen most recent attachments', async t => {
  process.env.PRIVATE_FILES_ENABLED='true';process.env.OCR_ENABLED='true';
  t.after(()=>{delete process.env.PRIVATE_FILES_ENABLED;delete process.env.OCR_ENABLED;});
  const attachment={storage:'private',fileId:id,originalName:'scan.pdf',mimetype:'application/pdf'};
  const history=[{role:'user',attachments:[attachment]},{role:'user',content:'全文をそのまま表示してください'}];
  assert.equal(exact.potential(history,{}),true);
  assert.equal(exact.potential(history,{ocrInputEnabled:false}),false);
  assert.equal(exact.potential(history,{pdfInputEnabled:false}),false);
  t.mock.method(store,'owned',async(user,fileId)=>{assert.equal(user,'owner');return {_id:fileId,originalName:'scan.pdf',mimetype:'application/pdf',checksum:'a',ocrCache:{version:3,checksum:'a',text:'unchanged'}};});
  const files=await exact.candidates('owner',history,{});assert.equal(files.length,1);
  assert.match(exact.options(files).instruction,/ANY language/);
  assert.equal('content' in exact.options(files).tool.function.parameters.properties,false);
  const largest=Array.from({length:10},(_,i)=>({id:String(i).padStart(24,'0'),name:'я'.repeat(255)}));
  assert.ok(Buffer.byteLength(JSON.stringify(exact.options(largest))) < exact.reserveBytes);
});
