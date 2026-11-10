// Request-local provenance. It is deliberately outside provider JSON, database
// history and user-controlled marker strings. Shallow message copies retain it.
const sources = new WeakMap();
function mark(part, file) {
  if (part && typeof part === 'object') sources.set(part, {
    fileId: String(file._id || file.fileId), filename: file.originalName, mimetype: file.mimetype,
  });
  return part;
}
module.exports = { mark, source: part => sources.get(part) };
