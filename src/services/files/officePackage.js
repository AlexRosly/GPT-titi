const sax = require('sax');
const path = require('node:path').posix;
const { fail } = require('./validation');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const P = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const invalid = () => { throw fail('INVALID_OFFICE_DOCUMENT'); };
const limit = () => { throw fail('OFFICE_DOCUMENT_LIMIT'); };
const attr = (node, name, uri = '') => Object.values(node.attributes).find(a => a.local === name && a.uri === uri)?.value;
function xml(bytes, handlers = {}, maxNodes = 100000) {
  if (!bytes) invalid();
  // OOXML commonly uses UTF-8 or UTF-16. Decode explicitly; never resolve entities.
  const utf16le = bytes[0] === 255 && bytes[1] === 254;
  const utf16be = bytes[0] === 254 && bytes[1] === 255;
  const text = new TextDecoder(utf16le ? 'utf-16le' : utf16be ? 'utf-16be' : 'utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw fail('OFFICE_DOCUMENT_UNSUPPORTED');
  const parser = sax.parser(true, { xmlns: true }); let depth = 0, nodes = 0;
  parser.onerror = invalid;
  parser.ondoctype = () => { throw fail('OFFICE_DOCUMENT_UNSUPPORTED'); };
  parser.onopentag = node => { if (++depth > 64 || ++nodes > maxNodes) limit(); handlers.open?.(node); };
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
function validate(parts, ext, maxMainNodes=100000) {
  const expected = ext === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
  for (const [name, bytes] of parts) {
    if (name.endsWith('.rels')) relationships(bytes, path.dirname(name).replace(/(?:^|\/)\_rels$/, ''));
    else if(name.endsWith('.xml'))xml(bytes, {}, name === expected ? maxMainNodes : 100000); // Also reject malformed/DTD-bearing unused parts.
  }
  const root = relationships(parts.get('_rels/.rels'), '');
  const main = [...root.values()].filter(r => r.type === R + '/officeDocument');
  if (main.length !== 1 || main[0].external || main[0].target !== expected) invalid();
  let contentType;
  xml(parts.get('[Content_Types].xml'), { open(node) {
    if (node.uri === CT && node.local === 'Override' && attr(node, 'PartName') === '/' + expected) contentType = attr(node, 'ContentType');
    if (/macroEnabled|vbaProject/i.test(attr(node, 'ContentType') || '')) throw fail('OFFICE_DOCUMENT_UNSUPPORTED');
  } });
  if (contentType !== (ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')) invalid();
  return expected;
}
module.exports={xml, relationships, validate, attr, W, S, R, invalid, limit};
