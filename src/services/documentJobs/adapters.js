// Adapter identity is stored with the job and survives a worker deployment.
const {fail}=require('../files/validation');
function excelSummary(r) {
  if (r.formulaTargets != null)
    return `Edited Excel copy attached. Wrote ${r.formulaTargets} formula cells. Reopened the copy and verified the expressions and numeric results of ${r.verifiedFormulas} cells.`;
  const changed = `Edited Excel copy attached. Processed ${r.processedRows} source rows and changed ${r.changed} cells.`;
  const skipped = ` Preserved ${r.formulaSkipped} targeted formula cells and skipped ${r.nonNumericSkipped} non-numeric or blank cells in numeric operations.`;
  const calculation = r.valueRecalculation;
  if (!calculation) return changed + skipped + ' Open the workbook in Excel for full recalculation.';
  const addresses = entries => entries.map(entry=>entry.sheet+'!'+entry.cell).join(', ');
  const examples = calculation.verifiedSample.length ? ' ('+addresses(calculation.verifiedSample)+')' : '';
  const verified = ` Reopened the workbook and verified ${calculation.verifiedCount} dependent formula results${examples}.`;
  if (!calculation.unverifiedCount) return changed + skipped + verified;
  const pending = addresses(calculation.unverifiedSample);
  return changed + skipped + verified + ` Cleared cached results for ${calculation.unverifiedCount} formulas requiring native calculation, including ${pending}. Open the copy in Excel, run a full recalculation and save it to refresh these results.`;
}
function get(name) {
  if(name==='docx-text-v1'){
    const engine=require('../docxBatch/engine');
    return {limits:engine.limits, unitsPerChunk:engine.limits.unitsPerChunk, hash:engine.hash, extension:'docx',
      sourceChanged:'DOCX_SOURCE_CHANGED', verificationFailed:'DOCX_BATCH_VERIFICATION_FAILED',
      total:s=>s.total, expected:p=>p.expectedMatches, processed:r=>r.processedParagraphs,
      summary:r=>'Edited DOCX attached. Checked '+r.processedParagraphs+' body paragraphs and replaced '+r.changed+' matching paragraphs. Structural checks passed.',
      run:(buffer,action,plan,options)=>require('./process').run(buffer,action,plan,{...options,adapter:name})};
  }
  if(name!=='xlsx-v1')throw fail('DOCUMENT_ADAPTER_UNSUPPORTED');
  const limits=require('../xlsx/policy').limits;
  return {limits,unitsPerChunk:limits.rowsPerChunk,hash:require('../xlsx/engine').hash,extension:'xlsx',
    sourceChanged:'XLSX_SOURCE_CHANGED',verificationFailed:'XLSX_VERIFICATION_FAILED',
    total:s=>s.scannedRows,expected:p=>p.expectedRows,processed:r=>r.processedRows,
    summary:excelSummary,
    run:(...args)=>require('../xlsx/process').run(...args)};
}
module.exports={get};
