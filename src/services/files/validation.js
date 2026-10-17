const path = require('node:path');
const fail = (code, status = 400) => Object.assign(new Error(code), { fileError: code, status });
const safeName = (name) => {
  if (typeof name !== 'string' || !name || Buffer.from(name).toString('utf8') !== name || Buffer.byteLength(name) > 180 || /[\x00-\x1f\x7f/\\]/.test(name) || name.startsWith('.')) throw fail('INVALID_FILENAME');
  return name;
};
const textExtensions = new Set('txt md csv tsv json xml yaml yml html css js jsx ts tsx py sql sh java c cpp h go rs rb php log'.split(' '));
const validateUpload = ({ originalname, buffer }) => {
  const name = safeName(originalname);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail('EMPTY_FILE');
  const ext = path.extname(name).slice(1).toLowerCase();
  let mimetype;
  if (ext === 'png' && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mimetype = 'image/png';
  if (['jpg', 'jpeg'].includes(ext) && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) mimetype = 'image/jpeg';
  if (ext === 'webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') mimetype = 'image/webp';
  if (ext === 'pdf' && buffer.toString('ascii', 0, 5) === '%PDF-') mimetype = 'application/pdf';
  if (['docx', 'xlsx', 'pptx', 'zip'].includes(ext) && buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    // Container identity is verified by the bounded Office reader before chat admission.
    mimetype = 'application/octet-stream';
  }
  if (textExtensions.has(ext)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw fail('INVALID_UTF8'); }
    if (buffer.includes(0)) throw fail('INVALID_TEXT');
    mimetype = ext === 'json' ? 'application/json' : 'text/plain';
  }
  if (!mimetype) throw fail('UNSUPPORTED_FILE_TYPE', 415);
  return { name, mimetype };
};
module.exports = { fail, safeName, validateUpload, textExtensions };
