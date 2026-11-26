// Byte windows never bisect a UTF-8 code point. Offsets belong to an immutable snapshot.
const CHUNK_BYTES = 12 * 1024;
const BATCH_BYTES = 5 * CHUNK_BYTES;
const SNAPSHOT_BYTES = 2 * 1024 * 1024;

function split(text, limit = CHUNK_BYTES) {
  const bytes = Buffer.from(text);
  const chunks = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(bytes.toString('utf8', start, end));
    start = end;
  }
  return chunks;
}

function capture(text, preview, incomplete = false) {
  if (!incomplete && text === preview) return { text, truncated: false };
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, SNAPSHOT_BYTES);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: preview, truncated: true, snapshot: bytes.toString('utf8', 0, end),
    captureIncomplete: incomplete || end < bytes.length };
}

// Search the entire snapshot, including matches spanning two adjacent chunks.
// Include both neighboring windows for heading text, definitions and table rows.
function selectedParts(chunks, needle) {
  const all = chunks.map((_, index) => index);
  if (!needle) return all;
  const text = chunks.join('');
  const offsets = [];
  let offset = 0;
  for (const chunk of chunks) { offsets.push(offset); offset += chunk.length; }
  const selected = new Set();
  let part = 0;
  for (let pos = text.indexOf(needle); pos !== -1; pos = text.indexOf(needle, pos + needle.length)) {
    while (part + 1 < offsets.length && offsets[part + 1] <= pos) part++;
    let last = part;
    while (last + 1 < offsets.length && offsets[last + 1] < pos + needle.length) last++;
    for (let i = Math.max(0, part - 1); i <= Math.min(chunks.length - 1, last + 1); i++) selected.add(i);
  }
  return selected.size ? [...selected] : all;
}

function plan(pages, needle) {
  const items = [];
  const coverage = {};
  for (const page of pages.filter(p => p.status === 'ready')) {
    const chunks = split(page.snapshot ?? page.text);
    const selected = selectedParts(chunks, needle);
    coverage[page.index] = { total: chunks.length, selected: selected.length, start: items.length,
      incomplete: Boolean(page.captureIncomplete || (!page.snapshot && page.truncated)) };
    for (const i of selected) items.push({ url: page.url, part: i + 1, text: chunks[i] });
  }
  return { items, coverage };
}

function batch(items, cursor, maxBytes = BATCH_BYTES) {
  const next = [];
  let size = 0;
  for (let i = cursor; i < items.length; i++) {
    const bytes = Buffer.byteLength(items[i].text);
    if (next.length && size + bytes > maxBytes) break;
    next.push(items[i]);
    size += bytes;
  }
  return next;
}

function progress(reading, index) {
  const page = reading?.coverage?.[index];
  if (!page) return null;
  return { read: Math.min(page.selected, Math.max(0, reading.cursor - page.start)),
    selected: page.selected, total: page.total, canContinue: !reading.finished };
}

function evidence({ snapshot, ...page }) { return page; }
module.exports = { split, capture, plan, batch, progress, evidence, CHUNK_BYTES, SNAPSHOT_BYTES };
