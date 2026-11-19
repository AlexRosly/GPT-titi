const { createHash } = require('node:crypto');
const { fail, safeName } = require('../files/validation');
const store = require('../files/store');
const sandbox = require('../computation/session');

const name = 'edit_pdf_table_cell';
const tool = {type:'function', function:{name, description:'Apply the exact PDF cell replacement specified by the user and verified by the server.',
  strict:true, parameters:{type:'object', properties:{}, required:[], additionalProperties:false}}};
const profile = 'pdf-table-number-v1';
const enabled = model => process.env.PDF_CELL_EDIT_ENABLED === 'true' && require('../computation/policy').enabled(model)
  && require('../files/pdfInput').enabled(model) && require('../files/artifacts').outputEnabled(model);
const quoted = '[«“"]([^»”"«“\\r\\n]{1,100})[»”"]';
const pattern = new RegExp('^(?:У |В )?(?:прикріпленому )?PDF на сторінці ([1-9][0-9]{0,5}) (?:у|в) рядку '+quoted+
  ' (?:у|в) колонці '+quoted+' заміни '+quoted+' на '+quoted+
  '\\.\\s*(?:Збережи решту тексту й оформлення\\.\\s*)?Поверни (?:відредаговану )?копію з назвою ([\\p{L}\\p{N}_-][\\p{L}\\p{N}_.-]*\\.pdf)\\.?$', 'iu');
const sha = value => createHash('sha256').update(value).digest('hex');

function plan(message, files, model) {
  if (!enabled(model) || files.length !== 1 || typeof message !== 'string') return null;
  const file = files[0];
  if (file.storage !== 'private' || !file.fileId || !/\.pdf$/i.test(file.originalName)) return null;
  const found = pattern.exec(message.trim());
  if (!found) return null;
  const [, page, row_key, column, old, replacement, filename] = found;
  if (Buffer.byteLength(filename)>180) return null;
  return {profile, fileId:String(file.fileId), filename, cell:{page_number:Number(page), row_key, column, old, new:replacement}};
}

function key(plan) {
  const c = plan.cell;
  return sha(JSON.stringify([profile, plan.fileId, plan.filename, c.page_number, c.row_key, c.column, c.old, c.new]));
}

async function run({turn, model, call, available, signal, completionAllowed}) {
  const plan = turn.pdfCellPlan;
  if (!completionAllowed || !enabled(model) || plan?.profile !== profile || call.function.name !== name)
    throw fail('PDF_CELL_UNAVAILABLE');
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { throw fail('PDF_CELL_INVALID_ACTION'); }
  if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).length) throw fail('PDF_CELL_INVALID_ACTION');
  if (!available.some(f => f.fileId === plan.fileId)) throw fail('COMPUTE_FILE_FORBIDDEN');
  safeName(plan.filename);
  const source = await store.owned(turn.user, plan.fileId);
  if (source.mimetype !== 'application/pdf' || !/\.pdf$/i.test(source.originalName) || source.size > 5*1024**2) throw fail('PDF_CELL_SIZE');
  if (source.originalName.normalize('NFC').toLowerCase() === plan.filename.normalize('NFC').toLowerCase()) throw fail('PDF_CELL_NEW_FILENAME_REQUIRED');
  const limits = require('../computation/policy').limits();
  const timeoutMs = Math.min(limits.runMs, limits.totalMs - turn.computeState.executionMs);
  if (timeoutMs <= 0) throw fail('COMPUTE_TIMEOUT');
  signal?.throwIfAborted();
  const {buffer} = await store.read(turn.user, plan.fileId);
  if (sha(buffer) !== source.checksum) throw fail('PDF_CELL_SOURCE_MISMATCH');
  const response = await sandbox.runPdfCell({source:buffer.toString('base64'), cell:plan.cell, timeoutMs}, signal);
  if (!response.ok) throw fail(/^PDF_CELL_[A-Z_]{1,42}$/.test(response.text) ? response.text : 'PDF_CELL_UNVERIFIED');
  const report = JSON.parse(response.text);
  if (report.page !== plan.cell.page_number || !Number.isInteger(report.pages) || report.pages < report.page ||
      report.pages > 12 || report.changedCells !== 1 || report.changedPages !== 1 ||
      response.exports.length !== 1 || typeof response.exports[0] !== 'string') throw fail('PDF_CELL_UNVERIFIED');
  const output = Buffer.from(response.exports[0], 'base64');
  if (output.length > 8*1024**2 || output.toString('ascii',0,5) !== '%PDF-') throw fail('PDF_CELL_UNVERIFIED');
  const evidence = {profile, key:key(plan), sourceChecksum:source.checksum, outputChecksum:sha(output),
    page:report.page, pages:report.pages, changedCells:1, changedPages:1};
  return {result:{ok:true,text:'PDF cell verified'}, prepared:[{name:plan.filename,mimetype:'application/pdf',buffer:output,
    documentEdit:{sourceFileId:plan.fileId,visualVerification:true,pdfCell:evidence}}],
    statePatch:{pdfCellEvidence:evidence}};
}

function matchesFile(turn, file) {
  const plan = turn.pdfCellPlan, evidence = turn.computeState?.pdfCellEvidence, actual = file?.documentEdit?.pdfCell;
  return Boolean(evidence && actual && file.originalName === plan.filename && file.mimetype === 'application/pdf' &&
    String(file._id) === turn.computeState.pdfCellFileId && file.documentEdit.sourceFileId === plan.fileId &&
    file.documentEdit.visualVerification === true && actual.profile === profile && actual.key === key(plan) &&
    actual.sourceChecksum === evidence.sourceChecksum && actual.outputChecksum === file.checksum &&
    actual.outputChecksum === evidence.outputChecksum && actual.page === plan.cell.page_number &&
    actual.pages === evidence.pages && actual.changedCells === 1 && actual.changedPages === 1);
}

function publication(turn) {
  if (!turn.pdfCellPlan) return null;
  const state = turn.computeState || {}, evidence = state.pdfCellEvidence;
  const file = state.files?.find(f => f.fileId === state.pdfCellFileId);
  const verified = file && evidence?.key === key(turn.pdfCellPlan) && evidence.changedCells === 1 &&
    evidence.changedPages === 1 && evidence.page === turn.pdfCellPlan.cell.page_number && state.pending === false &&
    !turn.responseState?.pending && !state.lastActionFailed && !turn.cancelRequestedAt && turn.providerResult?.computation?.status !== 'partial';
  return {assistantText:verified ? 'Edited PDF attached. Verified one table cell and compared all '+evidence.pages+' page(s).' :
    'PDF processing stopped before a verified copy could be delivered.',
    computation:{kind:'document', status:verified?'completed':'partial', files:verified?[file]:[],
      runs:state.runs, executionMs:state.executionMs, ...(verified?{}:{reason:turn.providerResult?.computation?.reason||state.lastActionError||'PDF_CELL_UNVERIFIED'})}};
}

function completion(turn) {
  const result = publication(turn), usage = turn.computeState?.usage;
  if (result?.computation.status !== 'completed' || !usage ||
      ![usage.promptTokens,usage.completionTokens,usage.totalTokens].every(n=>Number.isSafeInteger(n)&&n>=0)) return null;
  return {...result, usage};
}
module.exports = {name, tool, enabled, plan, run, matchesFile, publication, completion};
