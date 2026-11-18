const {fail} = require('../files/validation');

const profile = 'table-cell-text-v1';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
// Consume the whole instruction. Unrecognised multi-edit requests retain their normal workflow.
// Quoted document values are captured verbatim. Never obtain the selector from provider output.
const quoted = '(«[^«»"“”\\r\\n]{1,120}»|"[^«»"“”\\r\\n]{1,120}"|“[^«»"“”\\r\\n]{1,120}”)';
const request = new RegExp('^(?:(?:у|в) прикріпленому DOCX\\s+)?(?:у|в) таблиці\\s+' + quoted +
  '\\s+знайди рядок (?:із|з|за) кодом\\s+([\\p{L}\\p{N}_-]{1,64})[.,]\\s*' +
  '(?:тільки|лише) в цьому рядку (?:в|у) колонці\\s+' + quoted + '\\s+заміни\\s+' + quoted + '\\s+на\\s+' + quoted +
  '\\.(?:\\s+Збережи решту тексту й оформлення\\.)?' +
  '(?:\\s+Поверни відредаговану копію з назвою ([\\p{L}\\p{N}_-][\\p{L}\\p{N}_.-]{0,90}\\.docx)\\.?)?$', 'iu');

function plan(message, file) {
  if (process.env.DOCX_TABLE_TEXT_QA_ENABLED !== 'true') return null;
  const match = request.exec(message.trim());
  if (!match) return null;
  const code = match[2], filename = match[6];
  const [title, column, oldText, newText] = [match[1], match[3], match[4], match[5]].map(s => s.slice(1,-1));
  if (filename && Buffer.byteLength(filename) > 180) return null;
  if (oldText === newText || [title,column,oldText,newText].some(s => s !== s.trim() || !s.trim() || /[\u0000-\u001f]/u.test(s))) return null;
  return {profile,sourceFileId:String(file.fileId),cell:{title,code,column,oldText,newText},...(filename ? {filename} : {})};
}

function only(items, code = 'UNSUPPORTED') {
  if (items.length !== 1) throw fail('DOCX_QUALITY_' + code);
  return items[0];
}

const children = (node, local) => node.children.filter(n => n.uri === W && n.local === local);
const isWord = (node, local) => node?.uri === W && node.local === local;

function operation(doc, selector) {
  const body = only(children(doc.root,'body'));
  const table = only(body.children.filter((node,i,all) => isWord(node,'tbl') &&
    isWord(all[i-1],'p') && all[i-1].text === selector.title));
  const rows = children(table,'tr').map(row => children(row,'tc'));
  if (!rows.length || rows.some(row => row.length !== rows[0].length)) throw fail('DOCX_QUALITY_UNSUPPORTED');
  const columns = rows[0].map((cell,i) => ({name:cell.text,index:i}));
  const codeIndex = only(columns.filter(c => /^(код|code|id)$/iu.test(c.name))).index;
  const valueIndex = only(columns.filter(c => c.name === selector.column)).index;
  if (valueIndex === codeIndex) throw fail('DOCX_QUALITY_UNSUPPORTED');
  const row = only(rows.slice(1).filter(cells => cells[codeIndex].text === selector.code), 'COVERAGE');
  const cell = row[valueIndex];
  const p = only(children(cell,'p'));
  const run = only(children(p,'r'));
  const text = only(children(run,'t'));
  if (cell.text !== selector.oldText || text.text !== selector.oldText) throw fail('DOCX_QUALITY_COVERAGE');
  return {type:'replace_text',target:text.id,expected:selector.oldText,value:selector.newText};
}

// Only an invalid edit proposal is repairable. Never apply the next operation to the
// rejected candidate. The caller shares its cancellation signal and deadline across both.
const repairable = new Set([
  'DOCX_TARGET_NOT_FOUND', 'DOCX_TEXT_MISMATCH', 'DOCX_OVERLAPPING_OPERATIONS', 'DOCX_NO_CHANGES',
  'DOCX_INVALID_OPERATION', 'DOCX_QUALITY_CELL_MISMATCH', 'DOCX_QUALITY_OTHER_CHANGES',
]);

async function editVerified(plan, args, source, processDocument, remaining, signal) {
  async function attempt(workerArgs, repairAttempts) {
    const output = await processDocument(workerArgs);
    const verify = require('./signatureQuality').verify;
    const quality = await verify(plan, source, Buffer.from(output.buffer), signal, remaining());
    signal?.throwIfAborted();
    output.report = {...output.report, visualVerification:true, tableTextQuality:{...quality, repairAttempts}};
    return output;
  }
  try {
    return await attempt(args, 0);
  } catch (error) {
    signal?.throwIfAborted();
    if (!repairable.has(error.fileError)) throw error;
  }
  try {
    return await attempt({...args, repairCell:plan.cell}, 1);
  } catch (error) {
    if (!error.cleanupUnconfirmed && !signal?.aborted && repairable.has(error.fileError)) {
      throw fail('DOCX_QUALITY_CELL_MISMATCH');
    }
    throw error;
  }
}

function matchesCheckpoint(fileReport, saved) {
  return fileReport?.profile === profile && saved?.profile === profile &&
    fileReport.changedCells === 1 && fileReport.changedPages === 1 && fileReport.pages === saved.pages &&
    (fileReport.repairAttempts === 0 || fileReport.repairAttempts === 1) && fileReport.repairAttempts === saved.repairAttempts;
}

module.exports = {profile, plan, operation, editVerified, matchesCheckpoint};
