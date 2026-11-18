const { fail } = require('../computation/policy');
const sandbox = require('../computation/session');

const tableText = require('./tableText');
const profile = 'signature-lines-v1';
const errors = new Set(['CELL_MISMATCH', 'COVERAGE', 'OTHER_CHANGES', 'UNSUPPORTED', 'LIMIT', 'LAYOUT', 'TIMEOUT', 'RENDER']
  .map(suffix => 'DOCX_QUALITY_' + suffix));

// Initial opt-in covers explicitly counted full-row signature line requests on a single upload.
// The count comes from the user and is checked independently against the original document.
function plan(message, files) {
  if (typeof message !== 'string' || files.length !== 1) return null;
  const [file] = files;
  if (file.storage !== 'private' || !/\.docx$/i.test(file.originalName) || !file.fileId) return null;
  const cellPlan = tableText.plan(message, file);
  if (cellPlan) return cellPlan;
  if (process.env.DOCX_SIGNATURE_QA_ENABLED !== 'true') return null;
  const text = message.normalize('NFKC').toLowerCase();
  if (!/(?:тільки|лише|only)/u.test(text) || !/(?:подовж|продовж|extend|lengthen)/u.test(text) ||
      !/(?:ліні[їюй]|lines?\b)/u.test(text) ||
      !/(?:всю ширину|повну ширину|на всю довжину|full[- ]width|full width of)/u.test(text)) return null;
  const count = /(?:^|\s)(\d+|сімома|сімох|семи|сім|seven)\s+(?:підписант|signator|signer|signature)/u.exec(text);
  if (!count) return null;
  const expected = /^\d+$/.test(count[1]) ? Number(count[1]) : 7;
  if (!Number.isSafeInteger(expected) || expected < 1) return null;
  return {profile, sourceFileId: String(file.fileId), expected};
}

function validReport(plan, report) {
  if (plan?.profile === tableText.profile) {
    return report?.profile === plan.profile && report.changedCells === 1 && report.changedPages === 1 &&
      Number.isInteger(report.pages) && report.pages >= 1 && report.pages <= 40;
  }
  return report?.profile === profile && plan?.profile === profile &&
    Number.isSafeInteger(report.signatures) && report.signatures > 0 && report.signatures === plan.expected &&
    Number.isSafeInteger(report.pages) && report.pages > 0 && report.pages <= 40 &&
    Number.isSafeInteger(report.changedPages) && report.changedPages > 0 &&
    report.changedPages <= Math.min(report.pages, report.signatures);
}

async function verify(plan, source, result, signal, timeoutMs) {
  if (timeoutMs <= 0) throw fail('DOCX_QUALITY_TIMEOUT');
  let response;
  try {
    response = await sandbox.runDocxQuality({source:source.toString('base64'), result:result.toString('base64'),
      profile:plan.profile, expected:plan.expected, cell:plan.cell, timeoutMs}, signal);
  } catch (error) {
    if (error.cleanupUnconfirmed || signal?.aborted) throw error;
    if (error.fileError === 'COMPUTE_TIMEOUT') throw fail('DOCX_QUALITY_TIMEOUT');
    throw Object.assign(fail('DOCX_QUALITY_RENDER'), {qualityStage:'sandbox'});
  }
  if (!response.ok) {
    const error = fail(errors.has(response.text) ? response.text : 'DOCX_QUALITY_RENDER');
    const detail = response.diagnostic;
    if (error.fileError === 'DOCX_QUALITY_RENDER' && ['soffice','soffice_output','pdftotext','pdftoppm'].includes(detail?.stage)) {
      error.qualityStage = detail.stage;
      if (Number.isInteger(detail.exitCode) && detail.exitCode >= -127 && detail.exitCode <= 255) error.qualityExitCode = detail.exitCode;
    }
    throw error;
  }
  let report;
  try { report = JSON.parse(response.text); } catch { throw fail('DOCX_QUALITY_RENDER'); }
  if (!validReport(plan, report)) throw fail('DOCX_QUALITY_RENDER');
  if (plan.profile === tableText.profile) return {profile:plan.profile, changedCells:1, pages:report.pages, changedPages:1};
  return { profile, signatures: report.signatures, pages: report.pages, changedPages: report.changedPages };
}

// Publication and recovery use the marker saved in the same transaction as the file.
// A model response, an inspection, or a previous turn's output cannot attest to this edit.
function publication(turn) {
  const plan = turn.docxQualityPlan;
  if (!plan) return null;
  const state = turn.computeState || {};
  const data = turn.providerResult?.computation;
  const marker = state.docxCompletion;
  const file = state.files?.find(f => f.fileId === marker?.fileId);
  if (marker?.version === 1 && marker.run === state.runs && marker.sourceFileId === plan.sourceFileId &&
      file && state.kind === 'document' && state.pending === false && !turn.responseState?.pending && !state.lastActionFailed && !turn.cancelRequestedAt &&
      data?.status !== 'partial' && validReport(plan, marker.quality)) {
    const {signatures, pages} = marker.quality;
    const assistantText = plan.profile === tableText.profile
      ? 'Edited DOCX attached. Verified the requested text in one table cell and checked the rest of the document. ' +
        (pages === 1 ? 'Compared the rendered page.' : 'Compared all ' + pages + ' rendered pages.')
      : 'Edited DOCX attached. Verified ' + signatures + ' full-width signature lines. Compared all ' +
        pages + ' rendered pages and checked the surrounding text and layout.';
    return {assistantText,
    computation: {status:'completed', kind:'document', files:[file], runs:state.runs, executionMs:state.executionMs}};
  }
  const reason = data?.reason || state.lastActionError || 'DOCX_QUALITY_UNVERIFIED';
  return {assistantText: reason === 'USER_CANCELLED' ? 'Document processing was cancelled.' :
    'Document processing stopped before a verified DOCX could be delivered.',
  computation: {status:'partial', kind:'document', reason, files:[], runs:state.runs, executionMs:state.executionMs}};
}

module.exports = { plan, verify, publication };
