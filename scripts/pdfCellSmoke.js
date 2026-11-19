const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const {extract} = require('../src/services/files/pdfInput');

async function smoke(run = require('../src/services/computation/session').runPdfCell) {
  const source = await fs.readFile(path.join(__dirname,'../test/pdfCell/source.pdf'));
  const before = await extract(source);
  const cell = {page_number:2, row_key:'QA-202', column:'Дата', old:'13.11.2026', new:'07.11.2026'};
  for (const op of [cell,{...cell,column:'Сума, грн',old:'760,18',new:'7606,18'}]) {
    const request = {source:source.toString('base64'),cell:op,timeoutMs:60000};
    const result = await run(request);
    assert.ok(result.ok,result.text);
    assert.deepEqual(JSON.parse(result.text),{pages:2,page:2,changedPages:1,changedCells:1});
    assert.equal(result.exports.length,1);
    const after=await extract(Buffer.from(result.exports[0],'base64'));
    const row=before.indexOf('QA-202'),next=before.indexOf('QA-203',row);
    assert.ok(row>=0 && next>row && before.slice(row,next).includes(op.old));
    assert.equal(after,before.slice(0,row)+before.slice(row,next).replace(op.old,op.new)+before.slice(next));
  }
  const missing=await run({source:source.toString('base64'),cell:{...cell,row_key:'QA-999'},timeoutMs:60000});
  assert.equal(missing.ok,false);assert.equal(missing.text,'PDF_CELL_NOT_FOUND');assert.deepEqual(missing.exports,[]);
  console.log('PDF cell smoke passed: date, longer amount and missing row.');
}
if (require.main===module) smoke().catch(error=>{console.error(error.fileError||error.message);process.exitCode=1;});
module.exports={smoke};
