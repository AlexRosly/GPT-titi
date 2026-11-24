const mongoose = require('mongoose');
const crypto = require('node:crypto');
const path = require('node:path');
const File = require('../../models/managedFile');
const Quota = require('../../models/fileQuota');
const Chunk = require('../../models/fileChunk');
const Stage = require('../../models/fileUploadStage');
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
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > (source === 'generated' ? config.generatedMaxBytes() : config.maxBytes())) throw fail('FILE_TOO_LARGE', 413);
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
const STAGED_UPLOAD_THRESHOLD = 8 * 1024 ** 2;
const CHUNKS_PER_BATCH = 8;
const stageDeadline = () => new Date(Date.now() + 15 * 60_000);

async function* uploadChunks(upload, file, signal) {
  const hash = crypto.createHash('sha256');
  for (let offset = 0, index = 0; offset < upload.size; index++) {
    signal?.throwIfAborted();
    const data = Buffer.alloc(Math.min(CHUNK_BYTES, upload.size - offset));
    let filled = 0;
    while (filled < data.length) {
      const { bytesRead } = await upload.handle.read(data, filled, data.length - filled, offset + filled);
      if (!bytesRead) throw fail('FILE_UNAVAILABLE', 503);
      filled += bytesRead;
    }
    hash.update(data);
    yield { file, index, data };
    offset += data.length;
  }
  if (hash.digest('hex') !== upload.checksum) throw fail('FILE_UNAVAILABLE', 503);
}

async function stageUpload(args, stageId) {
  let batch = [];
  async function flush() {
    await transaction(async session => {
      args.signal?.throwIfAborted();
      const lease = await Stage.updateOne({ _id: stageId, cleaning: false },
        { $set: { expiresAt: stageDeadline() } }, { session });
      if (!lease.matchedCount) throw fail('FILE_UNAVAILABLE', 503);
      await Chunk.insertMany(batch, { session });
    });
    batch = [];
  }
  for await (const chunk of uploadChunks(args.upload, stageId, args.signal)) {
    batch.push(chunk);
    if (batch.length === CHUNKS_PER_BATCH) await flush();
  }
  if (batch.length) await flush();
}

async function discardStage(filter) {
  // A committed file has no stage marker. Competing writers and publication
  // both write this same marker in their transaction, fencing cleanup.
  const stage = await Stage.findOneAndUpdate(filter,
    { $set: { cleaning: true, expiresAt: new Date(0) } }, { new: true }).select('_id').lean();
  if (!stage) return;
  await Chunk.deleteMany({ file: stage._id });
  await Stage.deleteOne({ _id: stage._id, cleaning: true });
}

// Match an explicit Library upload against a live original for the same owner.
// Chat attachments keep distinct IDs even when the bytes are identical.
function libraryDuplicate(user, upload, session) {
  const extension = path.extname(upload.name).slice(1).toLowerCase();
  const suffix = ['jpg', 'jpeg'].includes(extension) ? /\.jpe?g$/i : new RegExp('\\.' + extension + '$', 'i');
  return File.findOne({ user, checksum: upload.checksum, size: upload.size, source: 'upload',
    status: 'ready', retention: { $ne: 'temporary' }, expiresAt: null, originalName: suffix }).sort({ _id: 1 })
    .select('_id originalName mimetype size source status version createdAt retention expiresAt').session(session).lean();
}

async function saveUpload(args, reuse) {
  const { user, upload, signal } = args;
  const { name, mimetype, size, checksum } = upload;
  // uploadLimit validates the extension before libraryDuplicate builds its suffix.
  if (!Number.isSafeInteger(size) || size < 1 || size > require('./limits').uploadLimit(name)) throw fail('FILE_TOO_LARGE', 413);
  signal?.throwIfAborted();
  await Quota.updateOne({ _id: user }, { $setOnInsert: { bytes: 0, count: 0 } }, { upsert: true });
  const large = size > STAGED_UPLOAD_THRESHOLD;
  if (large && reuse) {
    const existing = await libraryDuplicate(user, upload, null);
    if (existing) return { outcome: 'existing', file: existing };
  }
  const id = new mongoose.Types.ObjectId();
  if (large) {
    const hasSpace = await Quota.exists({ _id: user, bytes: { $lte: config.quotaBytes() - size } });
    if (!hasSpace) {
      // Another upload can publish the same file between the first lookup and the quota read.
      const existing = reuse && await libraryDuplicate(user, upload, null);
      if (existing) return { outcome: 'existing', file: existing };
      throw fail('FILE_QUOTA_EXCEEDED', 413);
    }
    await Stage.create({ _id: id, expiresAt: stageDeadline() });
  }
  let published = false;
  try {
    if (large) await stageUpload(args, id);
    const saved = await transaction(async session => {
      signal?.throwIfAborted();
      if (reuse) {
        const existing = await libraryDuplicate(user, upload, session);
        if (existing) return { outcome: 'existing', file: existing };
      }
      const reserved = await Quota.updateOne({ _id: user, bytes: { $lte: config.quotaBytes() - size } },
        { $inc: { bytes: size, count: 1 } }, { session });
      if (!reserved.modifiedCount) throw fail('FILE_QUOTA_EXCEEDED', 413);
      if (large) {
        const claim = await Stage.deleteOne({ _id: id, cleaning: false }, { session });
        if (!claim.deletedCount) throw fail('FILE_UNAVAILABLE', 503);
      } else {
        for await (const chunk of uploadChunks(upload, id, signal)) await Chunk.create([chunk], { session });
      }
      signal?.throwIfAborted();
      const [file] = await File.create([{ _id: id, user, originalName: name, mimetype, size, checksum,
        source: 'upload', retention: 'library', expiresAt: null }], { session });
      return { outcome: 'added', file };
    });
    published = saved.outcome === 'added';
    return saved;
  } finally {
    if (large && !published) await discardStage({ _id: id }).catch(() => {}); // Scheduled cleanup retries.
  }
}

const createUpload = async args => (await saveUpload(args, false)).file;
const uploadToLibrary = args => saveUpload(args, true);

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
  const expired = await Stage.find({ expiresAt: { $lte: new Date() } }).select('_id').limit(100).lean();
  for (const stage of expired) await discardStage({ _id: stage._id, expiresAt: { $lte: new Date() } });

  const files = await File.find({ status: 'ready', retention: { $ne: 'library' }, expiresAt: { $ne: null, $lte: new Date() } }).limit(100);
  for (const f of files) await transaction(async session => {
    const current = await owned(f.user, String(f._id), { session, includeDeleted: true });
    if (current.status === 'ready' && current.retention !== 'library' && current.expiresAt && current.expiresAt <= new Date()) await remove(f.user, String(f._id), session);
  });
};
module.exports = { createUpload, uploadToLibrary, create, owned, read, remove, removeTemporary, cleanup, transaction, dto, idOK };
