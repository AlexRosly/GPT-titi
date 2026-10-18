const File = require('../../models/managedFile');
const Quota = require('../../models/fileQuota');
const store = require('./store');
const config = require('./config');
const textInput = require('./textInput');
const processOcr = require('./ocrProcess');
const { fail } = require('./validation');
const images = new Set(['image/png', 'image/jpeg', 'image/webp']);
const supported = f => images.has(f.mimetype) || (f.mimetype === 'application/pdf' && /\.pdf$/i.test(f.originalName));
const enabled = model => config.enabled() && process.env.OCR_ENABLED !== 'false' && model?.ocrInputEnabled !== false;
const eligible = (file, model) => supported(file) && enabled(model) &&
  (file.mimetype !== 'application/pdf' || (process.env.PDF_INPUT_ENABLED !== 'false' && model?.pdfInputEnabled !== false));
const cached = file => [2, 3].includes(file.ocrCache?.version) && file.ocrCache?.checksum === file.checksum &&
  typeof file.ocrCache.text === 'string' && Buffer.byteLength(file.ocrCache.text) <= 65536;
// Old caches remain readable for turns already admitted before deployment.
const fresh = file => cached(file) && file.ocrCache.version === 3;
const pending = new Map();
const prepare = async (user, id, model) => {
  const file = await store.owned(user, id); // Always authorize before cache lookup, including in-flight jobs.
  if (!eligible(file, model) || fresh(file)) return;
  if (file.size > 5 * 1024 * 1024) throw fail('OCR_FILE_TOO_LARGE', 413);
  const key = `${user}:${id}:${file.checksum}`;
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    const { file: current, buffer } = await store.read(user, id);
    const result = await processOcr.extract(buffer, file.mimetype === 'application/pdf' ? 'pdf' : 'image');
    const bytes = Buffer.byteLength(result.text) + (result.detections?.length ? Buffer.byteLength(JSON.stringify(result.detections)) : 0);
    await store.transaction(async session => {
      const latest = await store.owned(user, id, { session });
      if (fresh(latest)) return; // Concurrent process winner; no duplicate quota claim.
      if (latest.checksum !== current.checksum) throw fail('FILE_UNAVAILABLE', 503);
      const delta = bytes - (latest.derivedBytes || 0);
      const claim = await Quota.updateOne({ _id: user, bytes: { $lte: config.quotaBytes() - delta } }, { $inc: { bytes: delta } }, { session });
      if (!claim.matchedCount) throw fail('FILE_QUOTA_EXCEEDED', 413);
      await File.updateOne({ _id: latest._id, user, status: 'ready', checksum: current.checksum }, { $set: {
        derivedBytes: bytes, ocrCache: { version: 3, checksum: current.checksum, text: result.text, pages: result.pages, languages: result.languages, detections: result.detections || [] },
      } }, { session });
    });
  })();
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
};
const beforeDeadline = async (deadline, start) => {
  const left = deadline - Date.now();
  if (left <= 0) throw fail('OCR_NOT_READY', 409);
  let timer;
  try {
    await Promise.race([start(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('OCR_NOT_READY', 409)), left);
    })]);
  } finally { clearTimeout(timer); }
};
const prepareFiles = async (user, files, model, deadline = Date.now() + 45000) => {
  if (!Array.isArray(files) || files.length > config.maxAttachments) throw fail('INVALID_ATTACHMENTS');
  let bytes = 0;
  const ids = [];
  // Reject invalid ownership/count/total size before spending OCR CPU.
  for (const f of files) {
    const id = f?.fileId || f?.id || f?._id;
    if (typeof id !== 'string') throw fail('FILE_ID_REQUIRED');
    if ([f.fileId, f.id, f._id].filter(Boolean).some(value => value !== id)) throw fail('INVALID_ATTACHMENTS');
    bytes += (await store.owned(user, id)).size;
    if (bytes > config.maxBytes()) throw fail('ATTACHMENTS_TOO_LARGE', 413);
    ids.push(id);
  }
  for (const id of ids) await beforeDeadline(deadline, () => prepare(user, id, model));
};
const prepareHistory = async (user, history, model, deadline = Date.now() + 45000) => {
  for (const message of history) {
    if (message.role !== 'user') continue;
    for (const f of message.attachments || []) {
      if (f.storage !== 'private') continue;
      try { await beforeDeadline(deadline, () => prepare(user, String(f.fileId), model)); }
      catch (error) { if (error.fileError !== 'FILE_NOT_FOUND') throw error; }
    }
  }
};
const readPart = async (user, file, { session, state = textInput.budget(), model } = {}) => {
  if (!eligible(file, model)) throw fail('OCR_INPUT_DISABLED', 415);
  // Never start OCR inside admission/retry transactions or after provider billing starts.
  const current = await store.owned(user, String(file._id || file.fileId), { session });
  if (!cached(current)) throw fail('OCR_NOT_READY', 409);
  textInput.consume(state, Buffer.byteLength(current.ocrCache.text));
  const output = textInput.part(current, current.ocrCache.text);
  state.promptBytes += Buffer.byteLength(output.text);
  return output;
};
module.exports = { supported, enabled, eligible, cached, prepare, prepareFiles, prepareHistory, readPart };
