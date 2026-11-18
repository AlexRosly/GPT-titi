// No account, database or model calls. Uses the same sandbox entry point as a live turn.
const assert = require('node:assert/strict');
const {
  Document, Packer, Paragraph, Table, TableRow, TableCell,
  WidthType, BorderStyle, TableLayoutType, HeightRule,
} = require('docx');
const engine = require('../src/services/docx/engine');
const quality = require('../src/services/docx/signatureQuality');

async function sample() {
  const widths = [2000, 2500, 1500];
  const none = {style:BorderStyle.NIL};
  const table = new Table({
    width:{type:WidthType.DXA,size:6000}, columnWidths:widths, layout:TableLayoutType.FIXED,
    borders:Object.fromEntries(['top','bottom','left','right','insideHorizontal','insideVertical'].map(k => [k,none])),
    rows:Array.from({length:7},(_,i) => new TableRow({
      height:{value:700,rule:HeightRule.ATLEAST},
      children:widths.map((size,col) => new TableCell({
        width:{type:WidthType.DXA,size},
        ...(col === 1 ? {borders:{bottom:{style:BorderStyle.SINGLE,size:4,color:'000000'}}} : {}),
        children:[new Paragraph(['Role '+(i+1),'','Signer '+(i+1)][col])],
      })),
    })),
  });
  return Packer.toBuffer(new Document({sections:[{children:[new Paragraph('Verification sample'),table]}]}));
}

async function cases(input) {
  input = input || await sample();
  const original = engine.load(input);
  const operations = [];
  for (const node of original.byId.values()) {
    if (node.local !== 'tbl') continue;
    let offset = 0;
    do {
      const part = engine.inspect(original,node.id,offset);
      for (const {cells} of part.items) {
        if (cells.length !== 3 || !cells[0].text.trim() || cells[1].text.trim() || !cells[2].text.trim()) continue;
        const center = cells[1].borders.find(b => b.side === 'bottom' && b.style === 'single');
        if (!center) continue;
        for (const cell of [cells[0],cells[2]]) operations.push({type:'cell_border',target:cell.id,
          side:'bottom',style:center.style,size:Number(center.size),color:center.color});
      }
      offset = part.nextOffset;
    } while (offset !== null);
  }
  assert.equal(operations.length,14,'The smoke specimen must have seven three-cell signature rows');
  const good = await engine.edit(original,operations);
  const six = await engine.edit(original,operations.slice(2));
  const firstText = [...original.byId.values()].find(n => n.local === 't' && n.text.trim());
  const shifted = await engine.edit(original,[...operations,{type:'replace_text',
    target:firstText.id,
    expected:firstText.text,
    value:'Changed by QA'}]);
  return {input,good:good.buffer,six:six.buffer,shifted:shifted.buffer};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--source')) throw Error('Usage: npm run docx:quality:smoke -- --source path/to/original.docx');
  const specimen = args.length ? await require('node:fs/promises').readFile(args[1]) : undefined;
  const {input,good,six,shifted} = await cases(specimen);
  const plan = {profile:'signature-lines-v1',expected:7};
  const check = b => quality.verify(plan,input,b,undefined,60000);
  for (let i=1; i<=3; i++) {
    const r = await check(good);
    assert.equal(r.signatures,7);
    console.log('Pass',i,'of 3. Seven signatures verified across',r.pages,'page(s).');
  }
  await assert.rejects(check(six),{fileError:'DOCX_QUALITY_COVERAGE'});
  await assert.rejects(check(shifted),{fileError:'DOCX_QUALITY_OTHER_CHANGES'});
  console.log('Pass. Six-of-seven and unrelated text change rejected.');
}

if (require.main === module) main().catch(error => {
  const fields = [error.fileError || error.message];
  if (error.qualityStage) fields.push('stage=' + error.qualityStage);
  if (error.qualityExitCode !== undefined) fields.push('exit=' + error.qualityExitCode);
  console.error(fields.join(' '));
  process.exitCode = 1;
});
module.exports = {cases};
