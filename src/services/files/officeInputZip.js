const { inflateRawSync } = require('node:zlib');
const { fail } = require('./validation');
const MAX_EXPANDED = 20 * 1024 * 1024;
const bad = () => { throw fail('INVALID_OFFICE_DOCUMENT'); };
const limit = () => { throw fail('OFFICE_DOCUMENT_LIMIT'); };
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
// Strict classic ZIP reader: no filesystem extraction, ZIP64, spanning or encryption.
module.exports = function readZip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) bad();
  const count = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  if (!count || count > 1000) limit();
  if (buffer.readUInt16LE(end + 8) !== count || start + size !== end) bad();
  const entries = new Map(), ranges = []; let cursor = start, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) bad();
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16), compressed = buffer.readUInt32LE(cursor + 20), length = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32), offset = buffer.readUInt32LE(cursor + 42);
    if (flags & (1 | 64) || buffer.readUInt16LE(cursor + 34)) throw fail('OFFICE_DOCUMENT_UNSUPPORTED');
    if (![0, 8].includes(method) || flags & ~(0x800 | 8 | 6)) throw fail('OFFICE_DOCUMENT_UNSUPPORTED');
    if (cursor + 46 + nameLength + extra + comment > end || offset + 30 > start) bad();
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    if (!name || /[\x00-\x1f\\%]/.test(name) || name.startsWith('/') || name.includes(':') || name.split('/').some(p => p === '..' || p === '.') || entries.has(name)) bad();
    expanded += length;
    if (expanded > MAX_EXPANDED || length > 8 * 1024 * 1024) limit();
    if (buffer.readUInt32LE(offset) !== 0x04034b50 || buffer.readUInt16LE(offset + 6) !== flags || buffer.readUInt16LE(offset + 8) !== method) bad();
    const localName = buffer.readUInt16LE(offset + 26), localExtra = buffer.readUInt16LE(offset + 28);
    const data = offset + 30 + localName + localExtra;
    if (data + compressed > start || !buffer.subarray(offset + 30, offset + 30 + localName).equals(nameBytes)) bad();
    if (!(flags & 8) && (buffer.readUInt32LE(offset + 14) !== crc || buffer.readUInt32LE(offset + 18) !== compressed || buffer.readUInt32LE(offset + 22) !== length)) bad();
    ranges.push([offset, data + compressed]);
    entries.set(name, { data, compressed, length, method, crc });
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end) bad();
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, i) => i && range[0] < ranges[i - 1][1])) bad();
  const output = new Map();
  for (const [name, e] of entries) {
    const raw = buffer.subarray(e.data, e.data + e.compressed);
    const bytes = e.method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, e.length) }) : raw;
    if (bytes.length !== e.length || crc32(bytes) !== e.crc) bad();
    // Validate every entry's bytes, but retain only XML parts used below.
    if (name.endsWith('.xml') || name.endsWith('.rels')) output.set(name, bytes);
    if (/vbaProject|\/embeddings\/|\/activeX\/|\/externalLinks\//i.test(name)) throw fail('OFFICE_DOCUMENT_UNSUPPORTED');
  }
  if (!output.has('[Content_Types].xml') || !output.has('_rels/.rels')) bad();
  return output;
};
