const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { fail } = require('./validation');
const config = require('./config');
const extensions = new Set(['pdf', 'docx', 'xlsx']);
const mimes = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const instructions = [
  'For PDF, DOCX and XLSX ONLY, content must be a JSON string describing the document, NOT binary, base64, Markdown or XML.',
  'For PDF/DOCX use {"title":"Title","blocks":[{"type":"heading","text":"Heading"},{"type":"paragraph","text":"Paragraph"},{"type":"bullet","text":"List item"},{"type":"table","rows":[["Column 1","Column 2"],["Value","Value"]]}]}.',
  'Use only these keys and block types. title may be empty. Maximum 300 blocks, 8000 characters per text block, 120000 characters overall; tables must be rectangular, at most 8 columns, 300 rows, 2000 characters per cell. Table cells are strings. Use short table cells so each PDF row fits on one page.',
  'For XLSX use {"sheets":[{"name":"Sheet1","rows":[["Product","Quantity"],["Apples",3]]}]}. Maximum 10 sheets, 2000 rows per sheet, 50 columns, 20000 cells total, 4000 characters per cell.',
  'XLSX cells must be string, finite number, boolean or null; the first row is a header. Sheet names must be unique, 1–31 characters, with no [ ] : * ? / or backslash, no leading/trailing apostrophe, and not History.',
  'This first version supports text, headings, bullets, tables and data workbooks. It does not support embedded images, charts, macros, formulas, external links, custom fonts, pixel-exact templates or digital signatures. Never claim those features were produced; explain limitations when requested. Do not encode formulas as text in place of working formulas.',
  'Write all actual content in the language requested by the user. The server supplies safe formatting and creates the real binary file.',
].join(' ');
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw fail('INVALID_DOCUMENT_CONTENT');
}
function text(value, max = 8000) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(value) || Buffer.from(value).toString('utf8') !== value) throw fail('INVALID_DOCUMENT_CONTENT');
  return value;
}
function validate(ext, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > config.artifactBytes) throw fail('INVALID_FILE_CONTENT');
  let value; try { value = JSON.parse(content); } catch { throw fail('INVALID_DOCUMENT_JSON'); }
  if (ext === 'xlsx') {
    keys(value, ['sheets']);
    if (!Array.isArray(value.sheets) || !value.sheets.length || value.sheets.length > 10) throw fail('DOCUMENT_LIMIT_EXCEEDED');
    let cells = 0; const names = new Set();
    for (const sheet of value.sheets) {
      keys(sheet, ['name', 'rows']); text(sheet.name, 31);
      const name = sheet.name.toLowerCase();
      if (!sheet.name.trim() || /[\x00-\x1f\[\]:*?/\\]/.test(sheet.name) || /^'|'$/.test(sheet.name) || name === 'history' || names.has(name)) throw fail('INVALID_SHEET_NAME');
      names.add(name);
      if (!Array.isArray(sheet.rows) || !sheet.rows.length || sheet.rows.length > 2000) throw fail('DOCUMENT_LIMIT_EXCEEDED');
      for (const row of sheet.rows) {
        if (!Array.isArray(row) || !row.length || row.length > 50 || (cells += row.length) > 20000) throw fail('DOCUMENT_LIMIT_EXCEEDED');
        for (const cell of row) {
          if (typeof cell === 'string') text(cell, 4000);
          else if (cell !== null && typeof cell !== 'boolean' && !(typeof cell === 'number' && Number.isFinite(cell))) throw fail('INVALID_DOCUMENT_CONTENT');
        }
      }
    }
  } else {
    keys(value, ['title', 'blocks']); text(value.title, 300);
    if (!Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > 300) throw fail('DOCUMENT_LIMIT_EXCEEDED');
    let chars = value.title.length;
    for (const block of value.blocks) {
      keys(block, block?.type === 'table' ? ['type', 'rows'] : ['type', 'text']);
      if (block.type === 'table') {
        if (!Array.isArray(block.rows) || !block.rows.length || block.rows.length > 300) throw fail('DOCUMENT_LIMIT_EXCEEDED');
        const width = block.rows[0]?.length;
        if (!width || width > 8) throw fail('DOCUMENT_LIMIT_EXCEEDED');
        for (const row of block.rows) {
          if (!Array.isArray(row) || row.length !== width) throw fail('INVALID_DOCUMENT_CONTENT');
          for (const cell of row) chars += text(cell, 2000).length;
        }
      } else {
        if (!['heading', 'paragraph', 'bullet'].includes(block.type)) throw fail('INVALID_DOCUMENT_CONTENT');
        chars += text(block.text).length;
      }
    }
    if (chars > 120000) throw fail('DOCUMENT_LIMIT_EXCEEDED');
  }
  return value;
}
// Preview is generated from the validated source, never by parsing an uploaded Office ZIP.
function preview(ext, value) {
  const out = ext === 'xlsx' ? { kind: 'workbook', sheets: [], truncated: false } : { kind: 'document', title: value.title, blocks: [], truncated: false };
  const fits = () => Buffer.byteLength(JSON.stringify(out)) <= 60000;
  if (ext === 'xlsx') {
    for (const source of value.sheets) {
      const sheet = { name: source.name, rows: [] }; out.sheets.push(sheet);
      for (const row of source.rows.slice(0, 200)) {
        sheet.rows.push(row.slice(0, 30));
        if (!fits()) { sheet.rows.pop(); out.truncated = true; return out; }
      }
      if (source.rows.length > 200 || source.rows.some(r => r.length > 30)) out.truncated = true;
    }
  } else {
    for (const block of value.blocks) {
      out.blocks.push(block);
      if (!fits()) { out.blocks.pop(); out.truncated = true; break; }
    }
  }
  return out;
}
async function render(spec, content) {
  const ext = path.extname(spec.filename).slice(1).toLowerCase();
  const value = validate(ext, content);
  const bytes = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'officeWorker.js'), { workerData: { ext, value, maxBytes: Math.min(config.maxBytes(), 8 * 1024 ** 2) }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
    const timer = setTimeout(() => { worker.terminate(); reject(fail('DOCUMENT_RENDER_TIMEOUT')); }, 15000);
    const finish = () => clearTimeout(timer);
    worker.once('message', result => { finish(); worker.terminate(); result.error ? reject(fail(result.error)) : resolve(Buffer.from(result.buffer)); });
    worker.once('error', () => { finish(); reject(fail('DOCUMENT_RENDER_FAILED')); });
    worker.once('exit', () => { finish(); reject(fail('DOCUMENT_RENDER_FAILED')); });
  });
  return { name: spec.filename, mimetype: mimes[ext], buffer: bytes, generatedPreview: preview(ext, value) };
}
module.exports = { extensions, instructions, validate, preview, render, mimes };
