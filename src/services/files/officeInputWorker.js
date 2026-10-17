const { parentPort, workerData } = require('node:worker_threads');
const sax = require('sax');
const path = require('node:path').posix;
const readZip = require('./officeInputZip');
const { fail } = require('./validation');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const invalid = () => { throw fail('INVALID_OFFICE_DOCUMENT'); };
const limit = () => { throw fail('OFFICE_DOCUMENT_LIMIT'); };
const attr = (node, name, uri = '') => Object.values(node.attributes).find(a => a.local === name && a.uri === uri)?.value;
function xml(bytes, handlers = {}) {
  if (!bytes) invalid();
  // OOXML commonly uses UTF-8 or UTF-16. Decode explicitly; never resolve entities.
  const utf16le = bytes[0] === 255 && bytes[1] === 254;
  const utf16be = bytes[0] === 254 && bytes[1] === 255;
  const text = new TextDecoder(utf16le ? 'utf-16le' : utf16be ? 'utf-16be' : 'utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw fail('OFFICE_DOCUMENT_UNSUPPORTED');
  const parser = sax.parser(true, { xmlns: true }); let depth = 0, nodes = 0;
  parser.onerror = invalid;
  parser.ondoctype = () => { throw fail('OFFICE_DOCUMENT_UNSUPPORTED'); };
  parser.onopentag = node => { if (++depth > 64 || ++nodes > 100000) limit(); handlers.open?.(node); };
  parser.onclosetag = () => { handlers.close?.(); depth--; };
  parser.ontext = value => handlers.text?.(value);
  parser.oncdata = value => handlers.text?.(value);
  parser.write(text).close();
}
function relationships(bytes, base) {
  const result = new Map();
  xml(bytes, { open(node) {
    if (node.uri !== P || node.local !== 'Relationship') return;
    const id = attr(node, 'Id'), target = attr(node, 'Target'), type = attr(node, 'Type');
    if (!id || !target || !type || result.has(id)) invalid();
    if (attr(node, 'TargetMode') === 'External') {
      // Ordinary hyperlinks are ignored. External data, templates and OLE are refused.
      if (type !== R + '/hyperlink') throw fail('OFFICE_DOCUMENT_UNSUPPORTED');
      result.set(id, { external: true, type }); return;
    }
    if (/[\\%?#\x00-\x1f]/.test(target) || target.includes(':')) invalid();
    const normalized = path.normalize(target.startsWith('/') ? target.slice(1) : path.join(base, target));
    if (normalized.startsWith('../')) invalid();
    result.set(id, { target: normalized, type });
  } });
  return result;
}
function extract(buffer, ext) {
  const parts = readZip(buffer);
  for (const [name, bytes] of parts) {
    if (name.endsWith('.rels')) relationships(bytes, path.dirname(name).replace(/(?:^|\/)\_rels$/, ''));
    else xml(bytes); // Also reject malformed/DTD-bearing unused parts.
  }
  const root = relationships(parts.get('_rels/.rels'), '');
  const main = [...root.values()].filter(r => r.type === R + '/officeDocument');
  const expected = ext === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
  if (main.length !== 1 || main[0].external || main[0].target !== expected) invalid();
  let contentType;
  xml(parts.get('[Content_Types].xml'), { open(node) {
    if (node.uri === CT && node.local === 'Override' && attr(node, 'PartName') === '/' + expected) contentType = attr(node, 'ContentType');
    if (/macroEnabled|vbaProject/i.test(attr(node, 'ContentType') || '')) throw fail('OFFICE_DOCUMENT_UNSUPPORTED');
  } });
  if (contentType !== (ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')) invalid();
  let output = '', bytes = 0;
  const append = text => { bytes += Buffer.byteLength(text); if (bytes > 65536) throw fail('OFFICE_EXTRACTED_TEXT_TOO_LARGE'); output += text; };
  if (ext === 'docx') {
    append('[DOCX text extraction: paragraphs and table cells in document order. Formatting, images, drawings, headers, footers, footnotes, comments and deleted revisions are not included. No embedded code or links are executed.]\n');
    const stack = []; let skip = 0, body = false, visible = 0;
    xml(parts.get(expected), {
      open(node) {
        const local = node.uri === W ? node.local : '';
        stack.push(local);
        if (local === 'body') body = true;
        if (['del', 'drawing', 'pict', 'object'].includes(local)) skip++;
        if (body && !skip && ['tab', 'br', 'cr'].includes(local)) append(local === 'tab' ? '\t' : '\n');
        if (['altChunk', 'subDoc'].includes(local)) throw fail('OFFICE_DOCUMENT_UNSUPPORTED');
      },
      text(value) { if (body && !skip && stack.at(-1) === 't') { append(value); visible += value.trim().length; } },
      close() {
        const local = stack.pop();
        if (body && !skip && ['p', 'tc', 'tr'].includes(local)) append(local === 'tc' ? '\t' : '\n');
        if (['del', 'drawing', 'pict', 'object'].includes(local)) skip--;
        if (local === 'body') body = false;
      },
    });
    if (!visible) throw fail('OFFICE_DOCUMENT_EMPTY');
  } else {
    append('[XLSX data extraction: sheet names, cell addresses and stored values. Formulas are NOT evaluated; cached results may be stale or absent. Numeric values are raw, without display formatting; date/time cells may contain Excel serial numbers. Images, charts and formatting are not read. Hidden sheets/rows/cells are included.]\n');
    const rels = relationships(parts.get('xl/_rels/workbook.xml.rels'), 'xl');
    const sheets = []; let date1904 = false;
    xml(parts.get(expected), { open(node) {
      if (node.uri !== S) return;
      if (node.local === 'workbookPr') date1904 = ['1', 'true'].includes(attr(node, 'date1904'));
      if (node.local === 'sheet') {
        const rel = rels.get(attr(node, 'id', R)), name = attr(node, 'name');
        if (!name || !rel || rel.type !== R + '/worksheet' || rel.external || !/^xl\/worksheets\/[^/]+\.xml$/.test(rel.target)) invalid();
        sheets.push({ name, target: rel.target, state: attr(node, 'state') || 'visible' });
        if (sheets.length > 20) limit();
      }
    } });
    if (!sheets.length || new Set(sheets.map(s => s.name)).size !== sheets.length) invalid();
    append(`Date system: ${date1904 ? '1904' : '1900'}\n`);
    const strings = []; let item = null, sharedBytes = 0; const stack = [];
    if (parts.has('xl/sharedStrings.xml')) xml(parts.get('xl/sharedStrings.xml'), {
      open(node) { stack.push(node.uri === S ? node.local : ''); if (stack.at(-1) === 'si') item = ''; },
      text(value) { if (item !== null && stack.at(-1) === 't' && !stack.includes('rPh')) { sharedBytes += Buffer.byteLength(value); if (sharedBytes > 1024 * 1024) limit(); item += value; } },
      close() { if (stack.pop() === 'si') { strings.push(item); item = null; if (strings.length > 20000) limit(); } },
    });
    const numberFormats = new Map([
      [0, 'General'], [1, '0'], [2, '0.00'], [9, '0%'], [10, '0.00%'],
      [14, 'mm-dd-yy'], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'],
      [18, 'h:mm AM/PM'], [19, 'h:mm:ss AM/PM'], [20, 'h:mm'], [21, 'h:mm:ss'],
      [22, 'm/d/yy h:mm'], [45, 'mm:ss'], [46, '[h]:mm:ss'], [47, 'mmss.0'], [49, '@'],
    ]);
    const styles = [], styleTags = [];
    if (parts.has('xl/styles.xml')) xml(parts.get('xl/styles.xml'), {
      open(node) {
        const local = node.uri === S ? node.local : '';
        if (local === 'numFmt') {
          const id = Number(attr(node, 'numFmtId')), format = attr(node, 'formatCode');
          if (!Number.isSafeInteger(id) || id < 0 || !format || format.length > 512) invalid();
          numberFormats.set(id, format);
        }
        if (local === 'xf' && styleTags.at(-1) === 'cellXfs') {
          styles.push(Number(attr(node, 'numFmtId') || 0));
          if (styles.length > 10000) limit();
        }
        styleTags.push(local);
      }, close() { styleTags.pop(); },
    });
    let count = 0;
    for (const sheet of sheets) {
      append(`SHEET ${JSON.stringify({ name: sheet.name, state: sheet.state })}\n`);
      let cell = null; const tags = [], seen = new Set();
      xml(parts.get(sheet.target), {
        open(node) {
          const local = node.uri === S ? node.local : ''; tags.push(local);
          if (local === 'c') {
            if (cell) invalid();
            const address = attr(node, 'r');
            if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address || '') || seen.has(address)) invalid();
            const [, col, row] = address.match(/^([A-Z]+)(\d+)$/);
            const column = [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
            if (column > 16384 || Number(row) > 1048576) invalid();
            seen.add(address); if (++count > 10000) limit();
            cell = { address, type: attr(node, 't') || 'n', style: attr(node, 's'), value: '', inline: '', formula: '', hasFormula: false };
          }
          if (local === 'f' && cell) { cell.hasFormula = true; cell.formulaType = attr(node, 't') || 'normal'; }
        },
        text(value) {
          if (!cell) return;
          const tag = tags.at(-1);
          if (tag === 'v') cell.value += value;
          if (tag === 'f') cell.formula += value;
          if (tag === 't' && tags.includes('is') && !tags.includes('rPh')) cell.inline += value;
        },
        close() {
          if (tags.pop() !== 'c') return;
          if (!cell) invalid();
          let value = cell.value;
          if (cell.type === 's') { if (!/^\d+$/.test(value) || Number(value) >= strings.length) invalid(); value = strings[Number(value)]; }
          else if (cell.type === 'inlineStr') value = cell.inline;
          else if (cell.type === 'b') { if (!['0', '1'].includes(value)) invalid(); value = value === '1'; }
          else if (!['n', 'str', 'e', 'd'].includes(cell.type)) invalid();
          if (value !== '' || cell.hasFormula) append(JSON.stringify({ cell: cell.address, type: cell.type, value, ...(cell.style ? { numberFormat: numberFormats.get(styles[Number(cell.style)]) || `builtin-format-${styles[Number(cell.style)] ?? 'unknown'}` } : {}), ...(cell.hasFormula ? { formula: cell.formula, formulaType: cell.formulaType, cachedResult: value === '' ? 'missing' : 'not recalculated' } : {}) }) + '\n');
          cell = null;
        },
      });
    }
    if (!count) throw fail('OFFICE_DOCUMENT_EMPTY');
  }
  return output;
}
try { parentPort.postMessage({ text: extract(Buffer.from(workerData.buffer), workerData.ext) }); }
catch (error) { parentPort.postMessage({ error: error.fileError || 'INVALID_OFFICE_DOCUMENT' }); }
