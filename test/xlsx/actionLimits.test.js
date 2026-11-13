const test=require('node:test'),assert=require('node:assert/strict');
test('XLSX inspection honors remaining execution time and the configured per-action cap',async t=>{
 const old={...process.env};t.after(()=>{process.env=old;});
 Object.assign(process.env,{PRIVATE_FILES_ENABLED:'true',COMPUTE_V2_ENABLED:'true',DOCUMENT_JOBS_ENABLED:'true',XLSX_EDIT_ENABLED:'true',COMPUTE_TOTAL_MS:'3000',COMPUTE_RUN_MS:'2000'});
 const store=require('../../src/services/files/store'),processXlsx=require('../../src/services/xlsx/process');
 t.mock.method(store,'owned',async()=>({originalName:'source.xlsx',size:1}));
 t.mock.method(store,'read',async()=>({buffer:Buffer.from('fixture')}));
 let timeout,executions=0;t.mock.method(processXlsx,'run',async(_,__,___,options)=>{timeout=options.timeoutMs;executions++;return {inspection:{sheets:[]}};});
 const fileId='0123456789abcdef01234567',turn={user:'owner',computeState:{files:[],executionMs:2900}};
 const input={turn,model:{},call:{function:{name:'inspect_xlsx',arguments:JSON.stringify({fileId,sheet:null,range:null,where:null,offset:0})}},available:[{fileId}]};
 await require('../../src/services/xlsx/action').run(input);assert.equal(timeout,100);
 turn.computeState.executionMs=0;await require('../../src/services/xlsx/action').run(input);assert.equal(timeout,2000);
 turn.computeState.executionMs=3000;
 await assert.rejects(require('../../src/services/xlsx/action').run(input),e=>e.fileError==='COMPUTE_RUN_LIMIT');
 assert.equal(executions,2);
});
