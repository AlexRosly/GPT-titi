const textPlan = require('./textPlan');
const {singleProfile, batchProfile, maxCells, parse, sha, key, covers} = require('./plan');
const { fail, safeName } = require('../files/validation');
const store = require('../files/store');
const sandbox = require('../computation/session');

const name = 'edit_pdf_table_cell';
const tool = {type:'function', function:{name, description:'Apply all requested PDF table edits in one verified copy.',
  strict:true, parameters:{type:'object', properties:{}, required:[], additionalProperties:false}}};
const textTool = {type:'function', function:{...tool.function, name:'edit_pdf_text',
  description:'Apply the requested scoped text replacements to the attached PDF and verify the copy.'}};
const toolFor = plan => plan?.profile === textPlan.profile ? textTool : tool;
const isTool = value => value === name || value === textTool.function.name;
const enabled = model => process.env.PDF_CELL_EDIT_ENABLED === 'true' && require('../computation/policy').enabled(model)
  && require('../files/pdfInput').enabled(model) && require('../files/artifacts').outputEnabled(model);
function plan(message, files, model) {
  if (!enabled(model) || files.length !== 1 || typeof message !== 'string') return null;
  const file = files[0];
  if (file.storage !== 'private' || !file.fileId || !/\.pdf$/i.test(file.originalName)) return null;
  return parse(message, String(file.fileId)) || textPlan.parseText(message, String(file.fileId), file.originalName);
}

async function run({turn, model, call, available, signal, completionAllowed}) {
  const plan = turn.pdfCellPlan;
  if (!completionAllowed || !enabled(model) || ![singleProfile, batchProfile, textPlan.profile].includes(plan?.profile) || call.function.name !== toolFor(plan).function.name)
    throw fail('PDF_CELL_UNAVAILABLE');
  if (plan.error) throw fail(plan.error);
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
  const textEdit = plan.profile === textPlan.profile;
  const edits = textEdit ? {text:plan.text} : plan.profile === batchProfile ? {cells:plan.cells} : {cell:plan.cell};
  const response = await sandbox.runPdfCell({source:buffer.toString('base64'), ...edits, timeoutMs}, signal);
  if (!response.ok) {
    const reason = /^PDF_CELL_[A-Z_]{1,42}$/.test(response.text) ? response.text : 'PDF_CELL_UNVERIFIED';
    const index = response.failedIndex;
    const targets = textEdit ? plan.text.changes : plan.cells;
    if (targets && Number.isInteger(index) && index >= 0 && index < targets.length) {
      return {result:{ok:false, text:reason}, prepared:[], statePatch:{pdfFailedIndex:index}};
    }
    throw fail(reason);
  }
  let report;
  try { report = JSON.parse(response.text); } catch { throw fail('PDF_CELL_UNVERIFIED'); }
  if (!covers(plan, report) || !Array.isArray(response.exports) ||
      response.exports.length !== 1 || typeof response.exports[0] !== 'string') throw fail('PDF_CELL_UNVERIFIED');
  const output = Buffer.from(response.exports[0], 'base64');
  if (output.length > 8*1024**2 || output.toString('ascii',0,5) !== '%PDF-') throw fail('PDF_CELL_UNVERIFIED');
  const coverage = textEdit ? {verifiedTexts:report.verifiedTexts, targetPages:report.targetPages, changedTexts:report.changedTexts} : plan.profile === batchProfile ? {verifiedCells:report.verifiedCells} : {page:report.page};
  const evidence = {profile:plan.profile, key:key(plan), sourceChecksum:source.checksum, outputChecksum:sha(output),
    pages:report.pages, changedCells:report.changedCells, changedPages:report.changedPages, ...coverage};
  return {result:{ok:true,text:textEdit ? 'PDF text replacements verified' : 'PDF cell verified'}, prepared:[{name:plan.filename,mimetype:'application/pdf',buffer:output,
    documentEdit:{sourceFileId:plan.fileId,visualVerification:true,pdfCell:evidence}}],
    statePatch:{pdfCellEvidence:evidence}};
}

function matchesFile(turn, file) {
  const plan = turn.pdfCellPlan, evidence = turn.computeState?.pdfCellEvidence, actual = file?.documentEdit?.pdfCell;
  return Boolean(evidence && actual && file.originalName === plan.filename && file.mimetype === 'application/pdf' &&
    String(file._id) === turn.computeState.pdfCellFileId && file.documentEdit.sourceFileId === plan.fileId &&
    file.documentEdit.visualVerification === true && actual.profile === plan.profile && evidence.profile === plan.profile && covers(plan, actual) &&
    covers(plan, evidence) && actual.key === key(plan) && evidence.key === actual.key &&
    actual.sourceChecksum === evidence.sourceChecksum && actual.outputChecksum === file.checksum &&
    actual.outputChecksum === evidence.outputChecksum && actual.pages === evidence.pages);
}

function failureText(turn, reason) {
  const cell = turn.pdfCellPlan.cells?.[turn.computeState?.pdfFailedIndex];
  const textChange = turn.pdfCellPlan.text?.changes?.[turn.computeState?.pdfFailedIndex];
  const target = textChange ? ` Запитана заміна: «${textChange.old}» → «${textChange.new}».` : cell ? ` Сторінка ${cell.page_number}, рядок «${cell.row_key}», колонка «${cell.column}».` : '';
  const messages = {
    PDF_CELL_TEXT_SCOPE:'Не вдалося однозначно визначити вказаний розділ або сторону.',
    PDF_CELL_TEXT_AMBIGUOUS:'Є кілька відповідників. Уточни сторінку, розділ або довший фрагмент.',
    PDF_CELL_TEXT_NOT_FOUND:'У вказаній області не знайдено потрібного тексту.',
    PDF_CELL_TEXT_SYNTAX:'Вкажи кожну заміну як «старий текст» на «новий текст» і, за потреби, назву розділу.',
    PDF_CELL_TEXT_OVERLAP:'Дві заміни стосуються того самого фрагмента.',
    PDF_CELL_TEXT_NO_CHANGE:'Указане значення вже є в документі.',
    PDF_CELL_TEXT_GLYPH:'У шрифті документа бракує символів для цієї заміни.',
    PDF_CELL_TEXT_STYLE:'Цей текстовий рядок має оформлення, яке редактор поки не підтримує.',
    PDF_CELL_TEXT_FIT:'Заміна не вміщується зі збереженням верстки.',
    PDF_CELL_TEXT_VERIFY:'Копія не пройшла перевірку тексту й вигляду сторінок.',
    PDF_CELL_TEXT_LAYER:'Для цієї заміни потрібен PDF із текстовим шаром.',
    PDF_CELL_NOT_FOUND:'У таблиці не знайдено вказаного рядка або колонки.',
    PDF_CELL_VALUE_MISMATCH:'Поточне значення клітинки відрізняється від указаного у запиті.',
    PDF_CELL_AMBIGUOUS:'Адреса відповідає кільком клітинкам.',
    PDF_CELL_DUPLICATE_TARGET:'Дві правки вказують на ту саму область таблиці.',
    PDF_CELL_BATCH_SIZE:`В одному запиті можна вказати до ${maxCells} клітинок.`,
    PDF_CELL_BATCH_SYNTAX:'Для кожної правки вкажи сторінку, рядок, колонку, старе й нове значення. Наприкінці вкажи назву копії.',
  };
  return messages[reason] ? messages[reason] + target + ' Копію не створено.' :
    'PDF processing stopped before a verified copy could be delivered.';
}

function publication(turn) {
  if (!turn.pdfCellPlan) return null;
  const state = turn.computeState || {}, evidence = state.pdfCellEvidence;
  const file = state.files?.find(f => f.fileId === state.pdfCellFileId);
  const verified = file && covers(turn.pdfCellPlan, evidence) && evidence.profile === turn.pdfCellPlan.profile &&
    evidence.key === key(turn.pdfCellPlan) && state.pending === false &&
    !turn.responseState?.pending && !state.lastActionFailed && !turn.cancelRequestedAt && turn.providerResult?.computation?.status !== 'partial';
  const reason = turn.providerResult?.computation?.reason || state.lastActionError || turn.pdfCellPlan.error || 'PDF_CELL_UNVERIFIED';
  const count = evidence?.changedCells === 1 ? 'one table cell' : `${evidence?.changedCells} table cells`;
  const success = evidence?.profile === textPlan.profile
    ? `Прикріплено виправлену копію PDF. Перевірено замін: ${evidence.changedTexts}. Порівняно сторінок: ${evidence.pages}.`
    : `Edited PDF attached. Verified ${count} and compared all ${evidence?.pages} page(s).`;
  return {assistantText:verified ? success : failureText(turn, reason),
    computation:{kind:'document', status:verified?'completed':'partial', files:verified?[file]:[],
      runs:state.runs, executionMs:state.executionMs, ...(verified ? {} : {reason})}};
}

function completion(turn) {
  const result = publication(turn), usage = turn.computeState?.usage;
  if (result?.computation.status !== 'completed' || !usage ||
      ![usage.promptTokens,usage.completionTokens,usage.totalTokens].every(n=>Number.isSafeInteger(n)&&n>=0)) return null;
  return {...result, usage};
}
module.exports = {maxCells, name, tool, toolFor, isTool, enabled, plan, run, matchesFile, publication, completion};
