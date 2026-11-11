// Bounded, original-preserving OOXML edits. Existing XML is never reserialized.
const crypto = require('node:crypto');
const sax = require('sax');
const JSZip = require('jszip');
const readZip = require('../files/officeInputZip');
const { fail } = require('../files/validation');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const error = (code = 'DOCX_EDIT_UNSUPPORTED') => { throw fail(code, 422); };
const child = (n, name) => n?.children.find(c => c.uri === W && c.local === name);
const children = (n, name) => n.children.filter(c => c.uri === W && c.local === name);
const attr = (n, name) => Object.values(n?.attributes || {}).find(a => a.uri === W && a.local === name)?.value;
const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function parse(xml, namespaces) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) error();
  const parser = sax.parser(true, { xmlns: true });
  if (namespaces) for (const key in namespaces) parser.ns[key] = namespaces[key];
  const stack = [], nodes = []; let root;
  parser.onerror = () => error('INVALID_OFFICE_DOCUMENT');
  parser.onopentag = tag => {
    if (stack.length >= 64 || nodes.length >= 100000) error('OFFICE_DOCUMENT_LIMIT');
    const n = { ...tag, start: parser.startTagPosition - 1, openEnd: parser.position,
      children: [], text: '', parent: stack.at(-1) };
    if (n.parent) n.parent.children.push(n); else root = n;
    stack.push(n); nodes.push(n);
  };
  parser.ontext = parser.oncdata = text => { for (const n of stack) n.text += text; };
  parser.onclosetag = () => { const n = stack.pop(); n.end = parser.position; };
  parser.write(xml).close();
  return { root, nodes };
}
function load(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 5 * 1024 ** 2) error('DOCX_EDIT_FILE_LIMIT');
  const parts = readZip(buffer, { all: true });
  if ([...parts.keys()].some(p => /_xmlsignatures|vbaProject|\/embeddings\/|\/activeX\//i.test(p))) error();
  // Reject external executable dependencies, signatures, protected documents and
  // revision markup rather than silently dropping it or invalidating signatures.
  for (const [name, bytes] of parts) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { error(); }
    const tree = parse(text);
    if (name.endsWith('.rels')) for (const n of tree.nodes) {
      const a = k => Object.values(n.attributes).find(v => v.local === k && !v.uri)?.value;
      if (n.local === 'Relationship' && a('TargetMode') === 'External' && !a('Type')?.endsWith('/hyperlink')) error();
      if (n.local === 'Relationship' && /digital-signature|attachedTemplate|oleObject|package$/.test(a('Type') || '')) error();
    }
    if (tree.nodes.some(n => n.uri === W && (n.local.endsWith('PrChange') || ['documentProtection', 'ins', 'del', 'moveFrom', 'moveTo', 'cellIns', 'cellDel', 'cellMerge', 'tblGridChange', 'altChunk', 'subDoc'].includes(n.local)))) error();
    if (name === '[Content_Types].xml' && /macroEnabled|vbaProject|digital-signature/i.test(text)) error();
  }
  const data = parts.get('word/document.xml');
  if (!data) error('INVALID_OFFICE_DOCUMENT');
  let xml; try { xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { error(); }
  const tree = parse(xml);
  if (tree.root.uri !== W || tree.root.local !== 'document') error();
  const byId = new Map(), counts = { tbl: 0, tc: 0, p: 0, t: 0 };
  const prefix = { tbl: 'table', tc: 'cell', p: 'p', t: 'text' };
  for (const n of tree.nodes) if (n.uri === W && Object.hasOwn(prefix, n.local)) {
    n.id = prefix[n.local] + counts[n.local]++; byId.set(n.id, n);
  }
  return { parts, xml, ...tree, byId, checksum: hash(buffer) };
}
const ancestor = (n, name) => { for (let p = n.parent; p; p = p.parent) if (p.uri === W && p.local === name) return p; };
function snippet(n, max = 500) { return { text: n.text.slice(0, max), textTruncated: n.text.length > max }; }
const inspection = require('../documents/inspection');
function cellDetails(c) {
  return {id:c.id, ...snippet(c),
    gridSpan:attr(child(child(c,'tcPr'),'gridSpan'),'val') || '1',
    verticalMerge:child(child(c,'tcPr'),'vMerge') ? attr(child(child(c,'tcPr'),'vMerge'),'val') || 'continue' : null,
    width:attr(child(child(c,'tcPr'),'tcW'),'w') || null,
    borders:(child(child(c,'tcPr'),'tcBorders')?.children || []).filter(b => b.uri === W)
      .map(b => ({side:b.local,style:attr(b,'val'),size:attr(b,'sz'),color:attr(b,'color')})),
    paragraphs:children(c,'p').map(p => p.id)};
}
function selectedRows(doc, target, query) {
  const ids = target.split(',');
  if (ids.length > 64 || new Set(ids).size !== ids.length || ids.some(id => !/^table\d+$/.test(id))) error('DOCX_TARGET_NOT_FOUND');
  return ids.flatMap(id => {
    const n = doc.byId.get(id);
    if (!n || n.local !== 'tbl') error('DOCX_TARGET_NOT_FOUND');
    const rows = children(n,'tr').map((node,index) => ({node,index,text:node.text,table:id}));
    return inspection.select(rows, query);
  });
}
function inspect(doc, target, offset, query = null) {
  const q = inspection.normalize(query);
  let items, render, selection;
  if (/^table\d+(,table\d+)*$/.test(target)) {
    items = selectedRows(doc,target,q);
    selection = {version:1,id:inspection.identity(doc.checksum,target,q),sourceChecksum:doc.checksum,
      target,query:q,rowCount:items.length,cellCount:items.reduce((n,r) => n + children(r.node,'tc').length,0)};
    render = r => ({...(target.includes(',') ? {table:r.table} : {}),row:r.index,cells:children(r.node,'tc').map(cellDetails)});
  } else {
    if (query !== null) error('DOCX_INVALID_QUERY_TARGET');
    if (target === 'document' || target === 'tables') {
      items = [...doc.byId.values()].filter(n => n.local === 'tbl' || target === 'document' && n.local === 'p' && !ancestor(n,'tbl'));
      render = n => ({id:n.id,kind:n.local === 'tbl' ? 'table' : 'paragraph',...snippet(n,200),
        ...(n.local === 'tbl' ? {rows:children(n,'tr').length,cells:children(n,'tr').reduce((sum,r) => sum + children(r,'tc').length,0)} : {})});
    } else {
      const n = doc.byId.get(target); if (!n) error('DOCX_TARGET_NOT_FOUND');
      if (n.local === 'p') {
        items = doc.nodes.filter(t => t.local === 't' && t.uri === W && ancestor(t,'p') === n);
        render = t => ({id:t.id,text:t.text});
      } else if (n.local === 'tc') return inspect(doc,children(n,'p')[0]?.id || '',offset);
      else error('DOCX_TARGET_NOT_FOUND');
    }
  }
  return inspection.present({base:{checksum:doc.checksum,target,...(selection ? {selection} : {}),
    verification:'Structure only. No page rendering or visual layout verification.'},items,offset,render,summary:q.mode === 'summary'});
}

function expandSelections(doc, operations, selections) {
  const expanded = [];
  for (const op of operations) {
    if (op.type !== 'selection_border') { expanded.push(op); continue; }
    const s = selections?.[op.selectionId];
    if (!s || s.version !== 1 || s.sourceChecksum !== doc.checksum ||
        inspection.identity(doc.checksum,s.target,s.query) !== op.selectionId) error('DOCX_SELECTION_REQUIRED');
    const rows = selectedRows(doc,s.target,s.query), cells = rows.flatMap(r => children(r.node,'tc'));
    if (cells.length !== op.expectedCells || cells.length !== s.cellCount || rows.length !== s.rowCount) error('DOCX_SELECTION_MISMATCH');
    if (expanded.length + cells.length > 10000) error('DOCX_OPERATION_LIMIT');
    for (const cell of cells) expanded.push({type:'cell_border',target:cell.id,side:op.side,style:op.style,size:op.size,color:op.color});
  }
  if (!expanded.length || expanded.length > 10000) error('DOCX_OPERATION_LIMIT');
  return expanded;
}

function fragment(name, inner = '', attributes = '', namespaces) {
  // Reuse an in-scope prefix. Redundant nested Word namespace declarations are
  // legal XML but some Office importers lose border formatting when reading them.
  let prefix;
  for (const key in namespaces) if (key && namespaces[key] === W) { prefix = key; break; }
  prefix ||= 'w';
  const declaration = namespaces?.[prefix] === W ? '' : ` xmlns:${prefix}="${W}"`;
  return `<${prefix}:${name}${declaration}${attributes.replace(/\bw:/g, `${prefix}:`)}>${inner}</${prefix}:${name}>`;
}
function replaceIn(xml, node, replacement) { return xml.slice(0, node.start) + replacement + xml.slice(node.end); }
// Insert property children in OOXML schema order, without touching other bytes.
function property(xml, parent, name, replacement, successors = []) {
  const existing = child(parent, name);
  if (existing) return replaceIn(xml, existing, replacement);
  if (parent.isSelfClosing) return replaceIn(xml, parent, xml.slice(parent.start, parent.openEnd).replace(/\/>$/, '>') + replacement + `</${parent.name}>`);
  const next = parent.children.find(n => n.uri === W && successors.includes(n.local));
  const at = next?.start ?? xml.lastIndexOf('</', parent.end);
  return xml.slice(0, at) + replacement + xml.slice(at);
}
function setProperty(source, container, name, replacement, successors, namespaces) {
  const tree = parse(source, namespaces), root = tree.root;
  const p = child(root, container);
  if (p) return property(source, p, name, replacement, successors);
  const value = fragment(container, replacement, '', namespaces);
  if (root.isSelfClosing) return property(source, root, container, value);
  return source.slice(0, root.openEnd) + value + source.slice(root.openEnd);
}
async function edit(doc, requested, selections = {}) {
  const operations = expandSelections(doc, requested, selections);
  const blocked = new Set();
  for (const n of doc.nodes) if (n.uri === W && ['fldChar','fldSimple','instrText','drawing','pict','sdt'].includes(n.local)) {
    for (let at = n; at; at = at.parent) blocked.add(at);
  }
  const changes = new Map(); const targets = new Set();
  for (const op of operations) {
    const node = doc.byId.get(op.target); if (!node) error('DOCX_TARGET_NOT_FOUND');
    const make = (name, inner, attributes) => fragment(name, inner, attributes, node.ns);
    // Fields, drawings, nested text boxes and content controls need dedicated adapters.
    if (blocked.has(node)) error();
    if (ancestor(node, 'sdt') || ancestor(node, 'fldSimple')) error();
    const key = op.target + ':' + (op.type === 'cell_border' ? op.side : op.type);
    if (targets.has(key)) error('DOCX_DUPLICATE_OPERATION'); targets.add(key);
    let source = changes.get(node) ?? doc.xml.slice(node.start, node.end);
    if (op.type === 'cell_border' && node.local === 'tc') {
      const border = make(op.side, '', ` w:val="${op.style}" w:sz="${op.size}" w:color="${op.color}"`);
      const tree = parse(source, node.ns), pr = child(tree.root, 'tcPr'), borders = child(pr, 'tcBorders');
      let updated;
      if (borders) {
        const order = ['top','start','left','bottom','end','right','insideH','insideV','tl2br','tr2bl'];
        // raw subtrees may inherit namespaces: use full-source offsets instead.
        updated = property(source, borders, op.side, border, order.slice(order.indexOf(op.side)+1));
      } else updated = setProperty(source, 'tcPr', 'tcBorders', make('tcBorders', border), ['shd','noWrap','tcMar','textDirection','tcFitText','vAlign','hideMark','headers','cellIns','cellDel','cellMerge','tcPrChange'], node.ns);
      source = updated;
    } else if (op.type === 'paragraph_alignment' && node.local === 'p') {
      source = setProperty(source, 'pPr', 'jc', make('jc', '', ` w:val="${op.value}"`), ['textDirection','textAlignment','textboxTightWrap','outlineLvl','divId','cnfStyle','rPr','sectPr','pPrChange'], node.ns);
    } else if (op.type === 'replace_text' && node.local === 't') {
      if (node.text !== op.expected) error('DOCX_TEXT_MISMATCH');
      let open = source.slice(0, node.openEnd - node.start).replace(/\/>$/, '>');
      if (/\bxml:space\s*=/.test(open)) open = open.replace(/\bxml:space\s*=\s*(['"])[^'"]*\1/, 'xml:space="preserve"');
      else open = open.slice(0,-1) + ' xml:space="preserve">';
      source = open + escape(op.value) + `</${node.name}>`;
    } else error('DOCX_INVALID_OPERATION');
    changes.set(node, source);
  }
  const sorted = [...changes].sort((a,b) => a[0].start-b[0].start);
  if (sorted.some(([n],i) => i && n.start < sorted[i-1][0].end)) error('DOCX_OVERLAPPING_OPERATIONS');
  const chunks = []; let cursor = 0;
  for (const [n,replacement] of sorted) { chunks.push(doc.xml.slice(cursor,n.start),replacement); cursor = n.end; }
  chunks.push(doc.xml.slice(cursor));
  const output = chunks.join('');
  if (output === doc.xml) error('DOCX_NO_CHANGES');
  parse(output);
  const zip = new JSZip();
  for (const [name,bytes] of doc.parts) zip.file(name, name === 'word/document.xml' ? Buffer.from(output) : bytes, {createFolders:false});
  const buffer = await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}});
  const verified = load(buffer);
  if (verified.parts.size !== doc.parts.size) error('DOCX_VERIFICATION_FAILED');
  for (const [name,bytes] of doc.parts) {
    const expected = name === 'word/document.xml' ? Buffer.from(output) : bytes;
    if (!verified.parts.get(name)?.equals(expected)) error('DOCX_VERIFICATION_FAILED');
  }
  // Check requested values after reopening, independently from ZIP generation.
  for (const op of operations) {
    const n = verified.byId.get(op.target);
    if (op.type === 'replace_text' && n?.text !== op.value) error('DOCX_VERIFICATION_FAILED');
    if (op.type === 'paragraph_alignment' && attr(child(child(n,'pPr'),'jc'),'val') !== op.value) error('DOCX_VERIFICATION_FAILED');
    if (op.type === 'cell_border') {
      const b = child(child(child(n,'tcPr'),'tcBorders'),op.side);
      if (attr(b,'val') !== op.style || attr(b,'sz') !== String(op.size) || attr(b,'color') !== op.color) error('DOCX_VERIFICATION_FAILED');
    }
  }
  return { buffer, report: { version:1, sourceChecksum:doc.checksum, resultChecksum:hash(buffer), operations:requested, expandedOperationCount:operations.length,
    changedParts:['word/document.xml'], otherPartsByteIdentical:true, requestedPropertiesVerified:true,
    documentXmlOutsideTargetsUnchanged:true, visualVerification:false } };
}
module.exports = { load, inspect, edit, hash };
