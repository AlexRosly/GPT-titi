// Format-independent selection and bounded presentation. Adapters scan the full
// source locally; a provider call is never used to advance an internal row page.
const crypto = require('node:crypto');
const MAX_BYTES = 14000;
const invalid = () => { throw Object.assign(Error('DOCUMENT_INVALID_QUERY'), {fileError:'DOCUMENT_INVALID_QUERY'}); };

function normalize(query) {
  if (query == null) return {mode:'rows', start:0, end:null, contains:null};
  if (typeof query !== 'object' || Array.isArray(query) ||
      Object.keys(query).some(k => !['mode','start','end','contains'].includes(k)) ||
      !['rows','summary'].includes(query.mode) || !Number.isSafeInteger(query.start) || query.start < 0 ||
      query.end !== null && (!Number.isSafeInteger(query.end) || query.end <= query.start) ||
      query.contains !== null && (typeof query.contains !== 'string' || !query.contains.length || query.contains.length > 256)) invalid();
  return {mode:query.mode, start:query.start, end:query.end,
    contains:query.contains === null ? null : query.contains.normalize('NFC')};
}

function select(rows, query) {
  const q = normalize(query), needle = q.contains?.toLowerCase();
  // Row numbers are source coordinates, never positions in a filtered sample.
  return rows.filter(r => r.index >= q.start && (q.end === null || r.index < q.end) &&
    (needle == null || r.text.normalize('NFC').toLowerCase().includes(needle)));
}

function identity(checksum, target, query) {
  const {mode, ...predicate} = normalize(query);
  // Presentation (summary/rows/cursor) does not change the selected range.
  return crypto.createHash('sha256').update(JSON.stringify({version:1,checksum,target,predicate})).digest('hex');
}

function present({base, items, offset = 0, render, summary = false, maxBytes = MAX_BYTES}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length || summary && offset !== 0) invalid();
  const indices = summary ? [...new Set([0,1,items.length-1])].filter(i => i >= 0 && i < items.length) : null;
  const out = {...base, total:items.length, offset, items:[], nextOffset:null,
    coverage:{displayed:0, matching:items.length, complete:items.length === 0, sampled:summary}};
  // Reserve cursor/coverage overhead before adding content. Exact final size is
  // checked below, including UTF-8 and JSON escaping, not just character count.
  const overhead = Buffer.byteLength(JSON.stringify(out)) + 128;
  let bytes = overhead;
  const count = indices ? indices.length : items.length - offset;
  for (let n = 0; n < count; n++) {
    const index = indices ? indices[n] : offset + n;
    const item = render(items[index]);
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > maxBytes) break;
    out.items.push(item); bytes += size;
  }
  if (!out.items.length && count) throw Object.assign(Error('DOCX_INSPECTION_LIMIT'), {fileError:'DOCX_INSPECTION_LIMIT'});
  out.coverage.displayed = out.items.length;
  out.coverage.complete = offset === 0 && out.items.length === items.length;
  if (!summary && offset + out.items.length < items.length) out.nextOffset = offset + out.items.length;
  if (Buffer.byteLength(JSON.stringify(out)) > maxBytes) throw Object.assign(Error('DOCX_INSPECTION_LIMIT'), {fileError:'DOCX_INSPECTION_LIMIT'});
  return out;
}

module.exports = {MAX_BYTES, normalize, select, identity, present};
