const mongoose = require('mongoose');
const crypto = require('node:crypto');
const path = require('node:path');
const File = require('../../models/managedFile');
const Quota = require('../../models/fileQuota');
const Chunk = require('../../models/fileChunk');
const config = require('./config');
const { fail } = require('./validation');
const CHUNK_BYTES = 256 * 1024;
const idOK = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
const dto = (f) => {
  const status = f.status === 'ready' && f.expiresAt && f.expiresAt <= new Date() ? 'expired' : f.status;
  const available = status === 'ready';
  return { fileId: String(f._id), id: String(f._id), originalName: f.originalName,
    mimetype: f.mimetype, size: f.size, source: f.source, status,
    version: f.version, createdAt: f.createdAt, retention: f.retention, expiresAt: f.expiresAt || null,
    url: available ? `/gpt-titi/api/files/${f._id}/download` : null,
    downloadUrl: available ? `/gpt-titi/api/files/${f._id}/download` : null,
    previewUrl: available ? `/gpt-titi/api/files/${f._id}/preview` : null };
};
const transaction = async (fn) => {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => fn(session)); }
  finally { await session.endSession(); }
};
const create = async ({ user, name, mimetype, buffer, generatedPreview = null, documentEdit = null, source = 'upload', resultKey, retention = 'library', session }) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > config.maxBytes()) throw fail('FILE_TOO_LARGE', 413);
  if (!session) return transaction((s) => create({ user, name, mimetype, buffer, generatedPreview, documentEdit, source, resultKey, retention, session: s }));
  if (!['library', 'temporary'].includes(retention) || (retention === 'temporary' && source !== 'generated')) throw fail('INVALID_FILE_RETENTION');
  if (generatedPreview && (source !== 'generated' || Buffer.byteLength(JSON.stringify(generatedPreview)) > 65536)) throw fail('INVALID_FILE_PREVIEW');
  if (documentEdit && (source !== 'generated' || Buffer.byteLength(JSON.stringify(documentEdit)) > 40000)) throw fail('INVALID_DOCUMENT_PROVENANCE');
  if (resultKey) {
    const existing = await File.findOne({ user, resultKey }).session(session);
    if (existing) return existing; // Tombstones prevent recreating a deleted result on replay.
  }
  await Quota.updateOne({ _id: user }, { $setOnInsert: { bytes: 0, count: 0 } }, { upsert: true, session });
  const reserved = await Quota.updateOne({ _id: user, bytes: { $lte: config.quotaBytes() - buffer.length } },
    { $inc: { bytes: buffer.length, count: 1 } }, { session });
  if (!reserved.modifiedCount) throw fail('FILE_QUOTA_EXCEEDED', 413);
  const [file] = await File.create([{ user, originalName: name, mimetype, size: buffer.length,
    generatedPreview, documentEdit,
    checksum: crypto.createHash('sha256').update(buffer).digest('hex'), source, resultKey,
    retention, expiresAt: retention === 'temporary' ? new Date(Date.now() + 3600000) : null }], { session });
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) chunks.push({ file: file._id, index: chunks.length, data: buffer.subarray(offset, offset + CHUNK_BYTES) });
  await Chunk.insertMany(chunks, { session });
  return file;
};
// The descriptor is private and remains open across transaction retries. Always read
// with explicit offsets; a retried transaction must restart at byte zero.
const persistUpload = async ({ user, upload, signal }, session) => {
  const { name, mimetype, size, checksum, handle } = upload;
  if (!Number.isSafeInteger(size) || size < 1 || size > require('./limits').uploadLimit(name)) throw fail('FILE_TOO_LARGE', 413);
  signal?.throwIfAborted();
  const reserved = await Quota.updateOne({ _id: user, bytes: { $lte: config.quotaBytes() - size } },
    { $inc: { bytes: size, count: 1 } }, { session });
  if (!reserved.modifiedCount) throw fail('FILE_QUOTA_EXCEEDED', 413);
  const [file] = await File.create([{ user, originalName: name, mimetype, size, checksum,
    source: 'upload', retention: 'library', expiresAt: null }], { session });
  const hash = crypto.createHash('sha256');
  for (let offset = 0, index = 0; offset < size; index++) {
    signal?.throwIfAborted();
    const data = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset));
    let filled = 0;
    while (filled < data.length) {
      const { bytesRead } = await handle.read(data, filled, data.length - filled, offset + filled);
      if (!bytesRead) throw fail('FILE_UNAVAILABLE', 503);
      filled += bytesRead;
    }
    hash.update(data);
    await Chunk.create([{ file: file._id, index, data }], { session });
    offset += data.length;
  }
  if (hash.digest('hex') !== checksum) throw fail('FILE_UNAVAILABLE', 503);
  signal?.throwIfAborted();
  return file;
};

const ensureUploadQuota = (user, session) => Quota.updateOne({ _id: user },
  { $setOnInsert: { bytes: 0, count: 0 } }, { upsert: true, session });
const createUpload = args => transaction(async session => {
  await ensureUploadQuota(args.user, session);
  return persistUpload(args, session);
});

// Explicit Files-page uploads only. Chat uploads retain independent file IDs.
// The checksum comes from the validated private spool, never from the client.
const uploadToLibrary = async args => {
  const { user, upload, signal } = args;
  signal?.throwIfAborted();
  const ext = path.extname(upload.name).slice(1).toLowerCase();
  if (!/^[a-z0-9]+$/.test(ext)) throw fail('UNSUPPORTED_FILE_TYPE', 415);
  const suffix = ['jpg', 'jpeg'].includes(ext) ? /\.jpe?g$/i : new RegExp('\\.' + ext + '$', 'i');
  // Bootstrap separately: first-time concurrent transactions must contend on an
  // existing quota document rather than racing an insert of the same _id.
  await ensureUploadQuota(user, null);
  return transaction(async session => {
    signal?.throwIfAborted();
    const existing = await File.findOne({ user, checksum: upload.checksum, size: upload.size,
      source: 'upload', status: 'ready', retention: { $ne: 'temporary' }, expiresAt: null,
      originalName: suffix }).sort({ _id: 1 })
      .select('_id originalName mimetype size source status version createdAt retention expiresAt').session(session).lean();
    if (existing) return { outcome: 'existing', file: existing };
    // Any two successful inserts must write the same owner's quota row. A
    // conflict retries this entire transaction, including the duplicate lookup.
    return { outcome: 'added', file: await persistUpload(args, session) };
  });
};

const owned = async (user, id, { session, includeDeleted = false } = {}) => {
  if (!idOK(String(id))) throw fail('FILE_NOT_FOUND', 404);
  const f = await File.findOne({ _id: id, user }).session(session || null);
  if (!f || (!includeDeleted && (f.status !== 'ready' || (f.expiresAt && f.expiresAt <= new Date())))) throw fail('FILE_NOT_FOUND', 404);
  return f;
};
const read = async (user, id, { session } = {}) => {
  const f = await owned(user, id, { session });
  const chunks = await Chunk.find({ file: f._id }).session(session || null).sort({ index: 1 });
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c.data)));
  if (buffer.length !== f.size || crypto.createHash('sha256').update(buffer).digest('hex') !== f.checksum) throw fail('FILE_UNAVAILABLE', 503);
  return { file: f, buffer };
};
const remove = async (user, id, session) => {
  if (!session) return transaction((s) => remove(user, id, s));
  const file = await owned(user, id, { session, includeDeleted: true });
  if (file.status === 'deleted') return;
  await File.updateOne({ _id: file._id }, { $set: { status: 'deleted', deletedAt: new Date(), generatedPreview: null, ocrCache: null, ocrProgress: null, zipCache: null, derivedBytes: 0 } }, { session });
  await require('../../models/filePreparation').updateMany({ user, file: file._id },
    { $set: { status: 'cancelled', errorCode: 'FILE_NOT_FOUND' }, $unset: { leaseToken: 1, leaseUntil: 1 } }, { session });
  await Chunk.deleteMany({ file: file._id }).session(session);
  await Quota.updateOne({ _id: user }, { $inc: { bytes: -(file.size + (file.derivedBytes || 0)), count: -1 } }, { session });
};
// Replacement inside a computation must never delete a file already published to the library.
const removeTemporary = async (user, id, session) => {
  if (!session) return transaction(s => removeTemporary(user, id, s));
  const file = await owned(user, id, { session, includeDeleted: true });
  if (file.retention === 'temporary' || (!file.retention && file.source === 'generated' && file.expiresAt)) await remove(user, id, session);
};
const cleanup = async () => {
  const files = await File.find({ status: 'ready', retention: { $ne: 'library' }, expiresAt: { $ne: null, $lte: new Date() } }).limit(100);
  for (const f of files) await transaction(async session => {
    const current = await owned(f.user, String(f._id), { session, includeDeleted: true });
    if (current.status === 'ready' && current.retention !== 'library' && current.expiresAt && current.expiresAt <= new Date()) await remove(f.user, String(f._id), session);
  });
};
module.exports = { createUpload, uploadToLibrary, create, owned, read, remove, removeTemporary, cleanup, transaction, dto, idOK };
