// Multer/Busboy decodes unlabelled multipart filename bytes as Latin-1.
// Recover browser UTF-8 at this transport boundary only, before validation.
// Leave explicitly decoded Unicode and genuine Latin-1 names unchanged.
module.exports = function uploadName(name) {
  if (typeof name !== 'string' || !/[^\x00-\x7f]/.test(name) || [...name].some(c => c.codePointAt(0) > 255)) return name;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(name, 'latin1'));
  } catch { return name; }
};
