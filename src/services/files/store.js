const mongoose = require('mongoose');
const crypto = require('node:crypto');
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
    version: f.version, expiresAt: f.expiresAt || null,
    url: available ? `/gpt-titi/api/files/${f._id}/download` : null,
    downloadUrl: available ? `/gpt-titi/api/files/${f._id}/download` : null,
    previewUrl: available ? `/gpt-titi/api/files/${f._id}/preview` : null };
};
const transaction = async (fn) => {
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => fn(session)); }
  finally { await session.endSession(); }
};
const create = async ({ user, name, mimetype, buffer, generatedPreview = null, source = 'upload', resultKey, session }) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > config.maxBytes()) throw fail('FILE_TOO_LARGE', 413);
  if (!session) return transaction((s) => create({ user, name, mimetype, buffer, generatedPreview, source, resultKey, session: s }));
  if (generatedPreview && (source !== 'generated' || Buffer.byteLength(JSON.stringify(generatedPreview)) > 65536)) throw fail('INVALID_FILE_PREVIEW');
  if (resultKey) {
    const existing = await File.findOne({ user, resultKey }).session(session);
    if (existing) return existing; // Tombstones prevent recreating a deleted result on replay.
  }
  await Quota.updateOne({ _id: user }, { $setOnInsert: { bytes: 0, count: 0 } }, { upsert: true, session });
  const reserved = await Quota.updateOne({ _id: user, bytes: { $lte: config.quotaBytes() - buffer.length }, count: { $lt: config.quotaCount() } },
    { $inc: { bytes: buffer.length, count: 1 } }, { session });
  if (!reserved.modifiedCount) throw fail('FILE_QUOTA_EXCEEDED', 413);
  const [file] = await File.create([{ user, originalName: name, mimetype, size: buffer.length,
    generatedPreview,
    checksum: crypto.createHash('sha256').update(buffer).digest('hex'), source, resultKey,
    expiresAt: source === 'upload' ? new Date(Date.now() + 86400000) : null }], { session });
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) chunks.push({ file: file._id, index: chunks.length, data: buffer.subarray(offset, offset + CHUNK_BYTES) });
  await Chunk.insertMany(chunks, { session });
  return file;
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
  await File.updateOne({ _id: file._id }, { $set: { status: 'deleted', deletedAt: new Date(), generatedPreview: null, ocrCache: null, derivedBytes: 0 } }, { session });
  await Chunk.deleteMany({ file: file._id }).session(session);
  await Quota.updateOne({ _id: user }, { $inc: { bytes: -(file.size + (file.derivedBytes || 0)), count: -1 } }, { session });
};
const cleanup = async () => {
  const files = await File.find({ status: 'ready', expiresAt: { $ne: null, $lte: new Date() } }).limit(100);
  for (const f of files) await remove(f.user, String(f._id));
};
module.exports = { create, owned, read, remove, cleanup, transaction, dto, idOK };
