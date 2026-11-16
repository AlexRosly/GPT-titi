// Maintenance for explicitly disposable development files. Never delete individual
// chunks independently: store.remove owns file status, caches, jobs and quota.
const File = require('../../models/managedFile');
const Chunk = require('../../models/fileChunk');
const Quota = require('../../models/fileQuota');
const Turn = require('../../models/chatTurn');
const DocumentJob = require('../../models/documentJob');
const store = require('./store');

function buildPlan(files, chunks, fraction = 0.5) {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw Error('Fraction must be greater than zero and at most one.');
  const metadata = new Map(files.map(file => [String(file._id), file]));
  const totalBytes = chunks.reduce((sum, row) => sum + row.bytes, 0);
  const targetBytes = Math.ceil(totalBytes * fraction);
  const candidates = [], unlinked = [];
  for (const row of chunks) {
    const file = metadata.get(String(row._id));
    if (!file || file.status !== 'ready') {
      unlinked.push({ fileId: String(row._id), bytes: row.bytes, chunks: row.count,
        reason: file ? 'already-deleted-file' : 'missing-file-metadata' });
      continue;
    }
    if (!Number.isSafeInteger(file.size) || file.size < 1 || !Number.isSafeInteger(file.derivedBytes || 0) || (file.derivedBytes || 0) < 0) throw Error(`Invalid file size: ${file._id}`);
    candidates.push({ fileId: String(file._id), userId: String(file.user), name: file.originalName,
      size: file.size, derivedBytes: file.derivedBytes || 0, checksum: file.checksum,
      chunkBytes: row.bytes, chunks: row.count });
  }
  // Free the requested amount by removing the fewest whole files. Equal-size
  // files have a deterministic order, so a saved plan can be reviewed/replayed.
  candidates.sort((a, b) => b.chunkBytes - a.chunkBytes || a.fileId.localeCompare(b.fileId));
  let selectedBytes = 0;
  const selected = [];
  for (const file of candidates) {
    if (selectedBytes >= targetBytes) break;
    selected.push(file); selectedBytes += file.chunkBytes;
  }
  return { version: 1, fraction, totalBytes, targetBytes, selectedBytes,
    totalChunks: chunks.reduce((sum, row) => sum + row.count, 0),
    selectedChunks: selected.reduce((sum, file) => sum + file.chunks, 0),
    readyFiles: files.filter(file => file.status === 'ready').length,
    targetReached: selectedBytes >= targetBytes, files: selected, unlinked };
}

async function inventory(fraction) {
  const [files, chunks] = await Promise.all([
    File.find({}).select('_id user originalName size derivedBytes checksum status').lean(),
    Chunk.aggregate([{ $group: { _id: '$file', bytes: { $sum: { $binarySize: '$data' } }, count: { $sum: 1 } } }]).option({ maxTimeMS: 60000 }),
  ]);
  return buildPlan(files, chunks, fraction);
}

async function assertIdle() {
  if (await Turn.exists({ status: { $in: ['queued', 'processing'] } }) ||
      await DocumentJob.exists({ status: { $in: ['queued', 'running'] } })) {
    throw Error('Active chat turns or document jobs found. Finish/stop them before development cleanup.');
  }
}

function assertSameFile(current, expected) {
  if (String(current.user) !== expected.userId || current.size !== expected.size ||
      (current.derivedBytes || 0) !== expected.derivedBytes || current.checksum !== expected.checksum) {
    throw Error(`File changed since preview: ${expected.fileId}. Create a new plan.`);
  }
}

async function apply(plan, onProgress = () => {}) {
  if (plan.version !== 1 || !Array.isArray(plan.files) || !plan.targetReached) throw Error('Invalid or incomplete cleanup plan.');
  const seen = new Set();
  for (const file of plan.files) {
    if (!store.idOK(file.fileId) || !store.idOK(file.userId) || seen.has(file.fileId)) throw Error('Invalid or duplicate file ID in cleanup plan.');
    seen.add(file.fileId);
  }
  await assertIdle();
  // Validate all remaining files and quota before deleting the first file.
  const owners = new Map();
  for (const expected of plan.files) {
    const file = await File.findById(expected.fileId).lean();
    if (!file || file.status === 'deleted') continue;
    assertSameFile(file, expected);
    const owner = owners.get(expected.userId) || { bytes: 0, count: 0 };
    owner.bytes += file.size + (file.derivedBytes || 0); owner.count++;
    owners.set(expected.userId, owner);
  }
  for (const [userId, expected] of owners) {
    const quota = await Quota.findById(userId).lean();
    if (!quota || quota.bytes < expected.bytes || quota.count < expected.count) throw Error(`Quota is inconsistent for owner ${userId}; cleanup stopped before deletion.`);
  }
  let deletedFiles = 0, skippedFiles = 0, deletedChunkBytes = 0;
  for (const expected of plan.files) {
    await assertIdle();
    const deleted = await store.transaction(async session => {
      const current = await File.findById(expected.fileId).session(session).lean();
      if (!current || current.status === 'deleted') return false;
      assertSameFile(current, expected);
      await store.remove(current.user, expected.fileId, session);
      return true;
    });
    if (deleted) { deletedFiles++; deletedChunkBytes += expected.chunkBytes; }
    else skippedFiles++;
    await onProgress({ fileId: expected.fileId, deleted, deletedFiles, skippedFiles, deletedChunkBytes });
  }
  return { deletedFiles, skippedFiles, deletedChunkBytes };
}

async function verify(plan) {
  const ids = plan.files.map(file => file.fileId);
  const [selected, selectedChunks, allChunks, readyFiles, expectedQuotas, quotas] = await Promise.all([
    File.find({ _id: { $in: ids } }).select('status').lean(),
    Chunk.countDocuments({ file: { $in: ids } }),
    Chunk.aggregate([{ $group: { _id: null, bytes: { $sum: { $binarySize: '$data' } }, count: { $sum: 1 } } }]).option({ maxTimeMS: 60000 }),
    File.countDocuments({ status: 'ready' }),
    File.aggregate([{ $match: { status: 'ready' } }, { $group: { _id: '$user',
      bytes: { $sum: { $add: ['$size', { $ifNull: ['$derivedBytes', 0] }] } }, count: { $sum: 1 } } }]),
    Quota.find({}).lean(),
  ]);
  const expected = new Map(expectedQuotas.map(row => [String(row._id), row]));
  const actual = new Map(quotas.map(row => [String(row._id), row]));
  const quotaMismatches = [];
  for (const owner of new Set([...expected.keys(), ...actual.keys()])) {
    const a = actual.get(owner) || { bytes: 0, count: 0 }, e = expected.get(owner) || { bytes: 0, count: 0 };
    if (a.bytes !== e.bytes || a.count !== e.count) quotaMismatches.push({ userId: owner, actualBytes: a.bytes,
      expectedBytes: e.bytes, actualCount: a.count, expectedCount: e.count });
  }
  return { selectedFiles: ids.length, selectedTombstones: selected.filter(file => file.status === 'deleted').length,
    remainingSelectedChunks: selectedChunks, remainingChunks: allChunks[0]?.count || 0,
    remainingChunkBytes: allChunks[0]?.bytes || 0, readyFiles, quotaMismatches };
}

module.exports = { buildPlan, inventory, assertSameFile, apply, verify };
