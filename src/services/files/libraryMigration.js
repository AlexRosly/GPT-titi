// Run with application/cleanup workers stopped. No remote URLs are fetched.
const crypto = require('node:crypto');
const File = require('../../models/managedFile');
const Chunk = require('../../models/fileChunk');
const Quota = require('../../models/fileQuota');
const { User } = require('../../models');
const store = require('./store');
const config = require('./config');
const classify = (file, now = new Date()) => {
  if (file.status !== 'ready') return 'deleted';
  if (file.expiresAt && file.expiresAt <= now) return 'expired';
  if (file.retention === 'temporary' || (file.source === 'generated' && file.expiresAt)) return 'temporary';
  return 'library';
};
async function verifyBytes(file, session) {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || !Number.isSafeInteger(file.derivedBytes || 0) || (file.derivedBytes || 0) < 0) throw Error('INVALID_SIZE');
  const hash = crypto.createHash('sha256'); let bytes = 0, index = 0;
  for await (const chunk of Chunk.find({ file: file._id }).session(session || null).sort({ index: 1 }).cursor()) {
    if (chunk.index !== index++) throw Error('INVALID_CHUNK_SEQUENCE');
    const data = Buffer.from(chunk.data); bytes += data.length; hash.update(data);
  }
  if (bytes !== file.size || hash.digest('hex') !== file.checksum) throw Error('FILE_INTEGRITY_FAILED');
}
async function migrate({ apply = false, repairQuota = false, now = new Date() } = {}) {
  if (repairQuota && !apply) throw Error('--repair-quota requires --apply');
  const report = { mode: apply ? 'apply' : 'dry-run', promoted: 0, temporary: 0, expired: 0, deleted: 0,
    alreadyPersistent: 0, quotaRepairs: 0, overQuotaUsers: 0, legacyFiles: await require('../../models/file').countDocuments(), problems: [] };
  const owners = new Map();
  for await (const file of File.find({}).cursor()) {
    const key = String(file.user);
    const owner = owners.get(key) || { user: file.user, bytes: 0, count: 0, files: [], blocked: false };
    owners.set(key, owner);
    const kind = classify(file, now);
    if (kind === 'deleted') { report.deleted++; continue; }
    owner.bytes += file.size + (file.derivedBytes || 0); owner.count++;
    try { await verifyBytes(file); }
    catch (e) { owner.blocked = true; report.problems.push({ user: key, fileId: String(file._id), code: e.message }); }
    if (kind === 'expired') report.expired++;
    else if (kind === 'temporary') { report.temporary++; owner.files.push({ id: file._id, kind }); }
    else if (file.retention === 'library' && !file.expiresAt) report.alreadyPersistent++;
    else owner.files.push({ id: file._id, kind });
  }
  // Include orphan quota counters, so the report cannot silently miss a mismatch.
  for await (const quota of Quota.find({}).cursor()) {
    const key = String(quota._id);
    if (!owners.has(key)) owners.set(key, { user: quota._id, bytes: 0, count: 0, files: [], blocked: false });
  }
  for (const [key, owner] of owners) {
    if (!await User.exists({ _id: owner.user })) {
      owner.blocked = true; report.problems.push({ user: key, code: 'OWNER_NOT_FOUND' });
    }
    const quota = await Quota.findById(owner.user).lean();
    owner.quotaMismatch = (quota?.bytes || 0) !== owner.bytes || (quota?.count || 0) !== owner.count;
    if (owner.quotaMismatch && !repairQuota) {
      owner.blocked = true; report.problems.push({ user: key, code: 'QUOTA_MISMATCH', expectedBytes: owner.bytes, expectedCount: owner.count });
    }
    if (owner.bytes > config.quotaBytes() || owner.count > config.quotaCount()) report.overQuotaUsers++;
  }
  // Validate the complete inventory before writing anything. Re-run after fixing problems.
  if (report.problems.length) return report;
  for (const owner of owners.values()) {
    if (apply && owner.quotaMismatch) {
      await Quota.updateOne({ _id: owner.user }, { $set: { bytes: owner.bytes, count: owner.count } }, { upsert: true });
      report.quotaRepairs++;
    }
    for (const item of owner.files) {
      if (apply) await store.transaction(async session => {
        const current = await store.owned(owner.user, String(item.id), { session, includeDeleted: true });
        if (classify(current) !== item.kind) throw Error('MIGRATION_STATE_CHANGED');
        await verifyBytes(current, session);
        await File.updateOne({ _id: item.id, user: owner.user, status: 'ready' },
          { $set: item.kind === 'library' ? { retention: 'library', expiresAt: null } : { retention: 'temporary' } }, { session });
      });
      if (item.kind === 'library') report.promoted++;
    }
  }
  return report;
}
module.exports = { migrate, classify, verifyBytes };
