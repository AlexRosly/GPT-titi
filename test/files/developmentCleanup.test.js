const test = require('node:test');
const assert = require('node:assert/strict');
const cleanup = require('../../src/services/files/developmentCleanup');
const File = require('../../src/models/managedFile');
const Quota = require('../../src/models/fileQuota');
const Turn = require('../../src/models/chatTurn');
const Job = require('../../src/models/documentJob');
const store = require('../../src/services/files/store');
const id = n => String(n).padStart(24, '0');
const file = (n, size) => ({ _id: id(n), user: id(99), originalName: `${n}.bin`, size, checksum: `hash-${n}`, status: 'ready' });
const chunks = (n, bytes, count = 1) => ({ _id: id(n), bytes, count });

test('selects at least half the chunk bytes as whole largest files, not half of arbitrary chunks', () => {
  const plan = cleanup.buildPlan([file(1, 60), file(2, 30), file(3, 10)], [chunks(1, 60, 3), chunks(2, 30, 2), chunks(3, 10)]);
  assert.equal(plan.targetBytes, 50);
  assert.equal(plan.selectedBytes, 60);
  assert.deepEqual(plan.files.map(f => f.fileId), [id(1)]);
  assert.equal(plan.selectedChunks, 3);
  assert.equal(plan.totalChunks, 6);
  assert.equal(plan.targetReached, true);
});

test('reports unlinked/deleted-file chunks and never silently deletes them', () => {
  const dead = { ...file(2, 60), status: 'deleted' };
  const plan = cleanup.buildPlan([file(1, 10), dead], [chunks(1, 10), chunks(2, 60), chunks(3, 60)]);
  assert.deepEqual(plan.files.map(f => f.fileId), [id(1)]);
  assert.equal(plan.targetReached, false);
  assert.deepEqual(plan.unlinked.map(f => f.reason), ['already-deleted-file', 'missing-file-metadata']);
});

test('rejects invalid fractions and chooses deterministically when sizes match', () => {
  for (const fraction of [0, -1, 2, NaN]) assert.throws(() => cleanup.buildPlan([], [], fraction));
  const plan = cleanup.buildPlan([file(2, 10), file(1, 10)], [chunks(2, 10), chunks(1, 10)]);
  assert.equal(plan.files[0].fileId, id(1));
});

function setup(t) {
  const records = [file(1, 60), file(2, 40)];
  const plan = cleanup.buildPlan(records, [chunks(1, 60), chunks(2, 40)]);
  const quota = { bytes: 100, count: 2 };
  const removed = [];
  const query = value => ({ lean: async () => value, session() { return this; } });
  t.mock.method(Turn, 'exists', async () => false);
  t.mock.method(Job, 'exists', async () => false);
  t.mock.method(File, 'findById', value => query(records.find(f => f._id === value)));
  t.mock.method(Quota, 'findById', () => query(quota));
  t.mock.method(store, 'transaction', async fn => fn('transaction-session'));
  t.mock.method(store, 'remove', async (owner, value, session) => {
    assert.equal(session, 'transaction-session');
    assert.equal(owner, id(99));
    removed.push(value);
    const record = records.find(f => f._id === value);
    record.status = 'deleted'; quota.bytes -= record.size; quota.count--;
  });
  return { records, plan, quota, removed };
}

test('uses existing transactional removal and replay does not refund twice or select another half', async t => {
  const f = setup(t);
  const first = await cleanup.apply(f.plan);
  assert.equal(first.deletedFiles, 1);
  assert.equal(first.deletedChunkBytes, 60);
  const second = await cleanup.apply(f.plan);
  assert.equal(second.deletedFiles, 0);
  assert.equal(second.skippedFiles, 1);
  assert.deepEqual(f.removed, [id(1)]);
  assert.deepEqual(f.quota, { bytes: 40, count: 1 });
});

test('rejects changed files and inconsistent quota before removing anything', async t => {
  const f = setup(t);
  f.records[0].checksum = 'changed';
  await assert.rejects(cleanup.apply(f.plan), /changed since preview/);
  f.records[0].checksum = 'hash-1'; f.quota.bytes = 1;
  await assert.rejects(cleanup.apply(f.plan), /Quota is inconsistent/);
  assert.deepEqual(f.removed, []);
});

test('active turns and document jobs prevent deletion', async t => {
  const f = setup(t);
  t.mock.method(Turn, 'exists', async () => true);
  await assert.rejects(cleanup.apply(f.plan), /Active chat turns/);
  t.mock.method(Turn, 'exists', async () => false);
  t.mock.method(Job, 'exists', async () => true);
  await assert.rejects(cleanup.apply(f.plan), /Active chat turns/);
  assert.deepEqual(f.removed, []);
});

test('tampered duplicate IDs are rejected before deletion', async t => {
  const f = setup(t);
  f.plan.files.push(f.plan.files[0]);
  await assert.rejects(cleanup.apply(f.plan), /duplicate file ID/);
  assert.deepEqual(f.removed, []);
});
