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
  const batch = require('../test/pdfCell/batchFixture');
  const runBatch = cells => run({source:source.toString('base64'), cells, timeoutMs:60000});
  const multi = await runBatch(batch.cells);
  assert.ok(multi.ok,multi.text);
  assert.equal(multi.exports.length,1);
  assert.deepEqual(JSON.parse(multi.text),batch.report);
  let expected = before;
  for (const op of batch.cells) {
    const start = expected.indexOf(op.row_key), end = expected.indexOf('QA-',start+op.row_key.length);
    assert.ok(start>=0 && end>start);
    const row = expected.slice(start,end);
    assert.ok(row.includes(op.old));
    expected = expected.slice(0,start)+row.replace(op.old,op.new)+expected.slice(end);
  }
  assert.equal(await extract(Buffer.from(multi.exports[0],'base64')),expected);
  const incomplete = await runBatch([...batch.cells.slice(0,-1),{...batch.cells.at(-1),row_key:'QA-999'}]);
  assert.equal(incomplete.text,'PDF_CELL_NOT_FOUND');assert.equal(incomplete.ok,false);
  assert.equal(incomplete.failedIndex,2);assert.deepEqual(incomplete.exports,[]);
  const textFixture = require('../test/pdfCell/textFixture');
  const textSource = await fs.readFile(path.join(__dirname,'../test/pdfCell/text_source.pdf'));
  const textRequest = {source:textSource.toString('base64'), timeoutMs:60000,
    text:{scope:textFixture.scope, changes:textFixture.changes}};
  const edited = await run(textRequest);
  assert.ok(edited.ok,edited.text);
  assert.deepEqual(JSON.parse(edited.text),textFixture.report);
  assert.equal(edited.exports.length,1);
  const editedText = await extract(Buffer.from(edited.exports[0],'base64'));
  assert.ok(editedText.includes('Самарівський район'));
  const ambiguous = await run({...textRequest,text:{...textRequest.text,scope:{page:2,section:null,party:null}}});
  assert.equal(ambiguous.ok,false);
  assert.equal(ambiguous.text,'PDF_CELL_TEXT_AMBIGUOUS');
  assert.deepEqual(ambiguous.exports,[]);
  console.log('PDF smoke passed: single and multiple cells, scoped Cyrillic text, atomic failure and ambiguity.');

}
if (require.main===module) smoke().catch(error=>{console.error(error.fileError||error.message);process.exitCode=1;});
module.exports={smoke};
