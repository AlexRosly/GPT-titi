// Adapter identity is stored with the job and survives a worker deployment.
const {fail}=require('../files/validation');
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
    summary:r=>`Edited Excel copy attached. Processed ${r.processedRows} source rows; changed ${r.changed} cells. Preserved ${r.formulaSkipped} targeted formula cells; skipped ${r.nonNumericSkipped} non-numeric or blank cells in numeric operations. Formula values were not recalculated; The workbook is marked for recalculation when opened.`,
    run:(...args)=>require('../xlsx/process').run(...args)};
}
module.exports={get};
