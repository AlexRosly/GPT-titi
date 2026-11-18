// The same synthetic document is available for manual, end-to-end chat acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../src/services/docx/engine');
const worker = require('../src/services/docx/process');
const quality = require('../src/services/docx/signatureQuality');
const table = require('../src/services/docx/tableText');

const source = fs.readFileSync(path.join(__dirname, '../test/docx/data/QA_DOCX_table_source.docx'));
const cell = {title:'Реєстр заявок', code:'QA-102', column:'Статус', oldText:'Чернетка', newText:'Прийнято'};
const plan = {profile:table.profile, sourceFileId:'smoke', cell};
const prompt = 'У прикріпленому DOCX у таблиці «Реєстр заявок» знайди рядок із кодом QA-102. ' +
  'Тільки в цьому рядку в колонці «Статус» заміни «Чернетка» на «Прийнято». Збережи решту тексту й оформлення. ' +
  'Поверни відредаговану копію з назвою QA_DOCX_table_result.docx.';

async function main() {
  const doc = engine.load(source);
  const expected = table.operation(doc, cell);
  const wrong = table.operation(doc, {...cell, code:'QA-101'});
  const third = table.operation(doc, {...cell, code:'QA-103'});
  const heading = doc.byId.get('p0');
  const check = operations => engine.edit(doc, operations)
    .then(result => quality.verify(plan, source, result.buffer, undefined, 60000));
  for (const [operations, reason] of [
    [[wrong], 'CELL_MISMATCH'],
    [[expected, wrong, third], 'OTHER_CHANGES'],
    [[expected, {type:'paragraph_alignment', target:heading.id, value:'right'}], 'OTHER_CHANGES'],
  ]) {
    await assert.rejects(check(operations), {fileError:'DOCX_QUALITY_' + reason});
  }
  console.log('Pass. Wrong row, three-row replacement and unrelated formatting rejected.');
  for (const [firstOperation, repairs] of [[expected, 0], [wrong, 1]]) {
    const args = {sourceChecksum:doc.checksum, operations:[firstOperation]};
    const deadline = Date.now() + 60000;
    const remaining = () => deadline - Date.now();
    const run = workerArgs => worker.run(source, 'edit_docx', workerArgs, undefined, remaining());
    const result = await table.editVerified(plan, args, source, run, remaining);
    const report = result.report.tableTextQuality;
    assert.equal(report.repairAttempts, repairs);
    assert.equal(report.changedCells, 1);
    const edited = engine.load(Buffer.from(result.buffer));
    assert.deepEqual([wrong, expected, third].map(op => edited.byId.get(op.target).text),
      [cell.oldText, cell.newText, cell.oldText]);
    console.log('Pass. One verified cell,', report.pages, 'page(s),', repairs, 'repair(s).');
  }
}

if (require.main === module) main().catch(error => { console.error(error.fileError || error.message); process.exitCode=1; });
module.exports = {source, cell, plan, prompt, main};
