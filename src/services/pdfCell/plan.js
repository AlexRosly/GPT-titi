const textPlan = require('./textPlan');
const {createHash} = require('node:crypto');

const singleProfile = 'pdf-table-number-v1';
const batchProfile = 'pdf-table-numbers-v2';
const maxCells = 64;
const quoted = /[«“"]([^«»“”"\r\n]{1,100})[»”"]/u.source;
const prefix = /^(?:(?:У|В)\s+)?(?:прикріпленому\s+)?PDF\s+/iu;
const introduction = /^внеси\s+(?:такі|наступні)\s+зміни\s*[:.]\s*/iu;
const instruction = new RegExp(
  '^(?:[-•]\\s+|[0-9]{1,3}[.)]\\s+)?на\\s+сторінці\\s+([1-9][0-9]{0,5})\\s+(?:у|в)\\s+рядку\\s+' + quoted +
  '\\s+(?:у|в)\\s+колонці\\s+' + quoted + '\\s+заміни\\s+' + quoted + '\\s+на\\s+' + quoted + '\\s*[.;]\\s*', 'iu');
const preservation = /^(?:Зміни\s+(?:тільки|лише)\s+(цю\s+клітинку|ці\s+клітинки)|Збережи\s+решту\s+тексту\s+й\s+оформлення)\.\s*/iu;
const output = /^Поверни\s+(?:відредаговану\s+)?копію\s+з\s+назвою\s+([\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.pdf)\.?$/iu;

function parse(message, fileId) {
  let rest = message.trim();
  if (!prefix.test(rest)) return null;
  rest = rest.replace(prefix, '');
  const explicitBatch = introduction.test(rest);
  rest = rest.replace(introduction, '');
  const cells = [];
  let match;
  while ((match = instruction.exec(rest))) {
    const [, page, row_key, column, old, replacement] = match;
    cells.push({page_number:Number(page), row_key, column, old, new:replacement});
    if (cells.length > maxCells) return {profile:batchProfile, fileId, error:'PDF_CELL_BATCH_SIZE'};
    rest = rest.slice(match[0].length);
  }
  const multi = cells.length > 1 || explicitBatch || (cells.length && /на\s+сторінці\s+\d/iu.test(rest));
  const invalid = multi ? {profile:batchProfile, fileId, error:'PDF_CELL_BATCH_SYNTAX'} : null;
  if (!cells.length || (explicitBatch && cells.length < 2)) return invalid;
  while ((match = preservation.exec(rest))) {
    if (multi && /^цю/iu.test(match[1] || '')) return invalid;
    rest = rest.slice(match[0].length);
  }
  const filename = output.exec(rest)?.[1];
  if (!filename || Buffer.byteLength(filename) > 180) return invalid;
  return multi ? {profile:batchProfile, fileId, filename, cells} : {profile:singleProfile, fileId, filename, cell:cells[0]};
}

const sha = value => createHash('sha256').update(value).digest('hex');
const fields = cell => [cell.page_number, cell.row_key, cell.column, cell.old, cell.new];
const receipt = cell => sha(JSON.stringify(fields(cell)));

function key(plan) {
  if (plan.profile === textPlan.profile) {
    const {scope, changes} = plan.text;
    return sha(JSON.stringify([plan.profile, plan.fileId, plan.filename, scope.page, scope.section,
      scope.party, changes.map(c => [c.old,c.new,c.scope?.page,c.scope?.section,c.scope?.party])]));
  }
  const targets = plan.profile === singleProfile ? fields(plan.cell) : plan.cells.map(fields);
  return sha(JSON.stringify([plan.profile, plan.fileId, plan.filename, ...targets]));
}

function covers(plan, report) {
  if (plan.error || !report || !Number.isInteger(report.pages) || report.pages < 1 || report.pages > 12) return false;
  if (plan.profile === textPlan.profile) {
    const {changes, scope} = plan.text;
    const pages = report.targetPages;
    return Array.isArray(pages) && pages.length === changes.length && changes.length > 0 &&
      pages.every((p,i) => {
        const selected = changes[i].scope || scope;
        return Number.isInteger(p) && p >= 1 && p <= report.pages && (!selected.page || selected.page === p);
      }) &&
      report.changedTexts === changes.length && report.changedPages === new Set(pages).size &&
      Array.isArray(report.verifiedTexts) && report.verifiedTexts.length === changes.length &&
      changes.every((c,i) => report.verifiedTexts[i] === sha(JSON.stringify([c.old,c.new,pages[i]])));
  }
  if (plan.profile === singleProfile) {
    return plan.cell.page_number >= 1 && report.page === plan.cell.page_number && report.pages >= report.page &&
      report.changedCells === 1 && report.changedPages === 1;
  }
  const cells = plan.cells;
  return plan.profile === batchProfile && Array.isArray(cells) && cells.length >= 2 && cells.length <= maxCells &&
    cells.every(c => Number.isInteger(c.page_number) && c.page_number >= 1 && c.page_number <= report.pages) &&
    report.changedPages === new Set(cells.map(c => c.page_number)).size && report.changedCells === cells.length &&
    Array.isArray(report.verifiedCells) && report.verifiedCells.length === cells.length &&
    cells.every((c, i) => report.verifiedCells[i] === receipt(c));
}

module.exports = {singleProfile, batchProfile, maxCells, parse, sha, key, covers};
