const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const rules = require('../src/services/pinning/pinningRules');
const projectId = '111111111111111111111111';
const conversationId = '222222222222222222222222';
const userId = '333333333333333333333333';
const load = (file, models) => {
  const sandbox = { module: { exports: {} }, console: { error() {} }, Date, require: (id) => {
    if (id === '../../models') return models;
    if (id === 'mongoose') return { Types: { ObjectId: { isValid: (id) => /^[a-f0-9]{24}$/i.test(id) } } };
    if (id === '../../services/pinning') return rules;
    throw Error(id);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/controllers/projects', file), 'utf8'), sandbox);
  return sandbox.module.exports;
};
const fixture = ({ owned = true, member = true } = {}) => {
  const record = { pinnedAt: 'global-pin-unchanged', projectPinnedAt: null };
  const calls = [];
  const controller = load('updateProjectConversationPin.js', {
    Project: { exists: async (filter) => { assert.deepEqual(JSON.parse(JSON.stringify(filter)), { _id: projectId, user: userId, deleted: null }); return owned; } },
    ChatConversation: { findOneAndUpdate: async (filter, update, options) => {
      calls.push({ filter, update, options });
      assert.deepEqual(JSON.parse(JSON.stringify(filter)), { _id: conversationId, user: userId, project: projectId, archived: false });
      assert.deepEqual(Object.keys(update[0].$set), ['projectPinnedAt']);
      if (!member) return null;
      record.projectPinnedAt = update[0].$set.projectPinnedAt === null ? null : record.projectPinnedAt || 'server-time';
      return record;
    } },
  });
  const request = async (body, params = { projectId, conversationId }) => {
    const response = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.body = data; return this; } };
    await controller({ params, body, user: { _id: userId } }, response);
    return response;
  };
  return { request, record, calls };
};
test('project pin and duplicate pin leave global pin unchanged; unpin is idempotent', async () => {
  const f = fixture();
  assert.equal((await f.request({ pinned: true })).body.projectPinnedAt, 'server-time');
  await f.request({ pinned: true });
  assert.equal(f.record.projectPinnedAt, 'server-time');
  await f.request({ pinned: false }); await f.request({ pinned: false });
  assert.equal(f.record.projectPinnedAt, null); assert.equal(f.record.pinnedAt, 'global-pin-unchanged');
});
test('invalid IDs and payloads cannot write', async () => {
  const f = fixture();
  for (const body of [{}, { pinned: 'true' }, { pinned: true, pinnedAt: 'spoof' }, { pinned: true, projectPinnedAt: null }]) {
    assert.equal((await f.request(body)).code, 400);
  }
  assert.equal((await f.request({ pinned: true }, { projectId: 'bad', conversationId })).code, 400);
  assert.equal(f.calls.length, 0);
});
test('foreign or deleted project cannot pin any conversation', async () => {
  const f = fixture({ owned: false }); assert.equal((await f.request({ pinned: true })).code, 404); assert.equal(f.calls.length, 0);
});
test('wrong membership, foreign user or archived conversation cannot be pinned', async () => {
  const f = fixture({ member: false }); assert.equal((await f.request({ pinned: true })).code, 404); assert.equal(f.record.projectPinnedAt, null);
});
test('project and global sorts and timestamp expressions remain independent', () => {
  assert.deepEqual(rules.PROJECT_CONVERSATION_SORT, { projectPinnedAt: -1, lastMessageAt: -1, _id: -1 });
  assert.deepEqual(rules.CONVERSATION_SORT, { pinnedAt: -1, lastMessageAt: -1, _id: -1 });
  assert.deepEqual(rules.buildPinnedAtExpression(true, 'projectPinnedAt'), { $ifNull: ['$projectPinnedAt', '$$NOW'] });
  assert.deepEqual(rules.buildPinnedAtExpression(true), { $ifNull: ['$pinnedAt', '$$NOW'] });
});
test('membership changes clear only project pin; same-project add preserves it', async () => {
  let update;
  const project = { _id: projectId, save: async () => {} };
  const add = load('addConversationsToProject.js', { Project: { findOne: async () => project }, ChatConversation: { updateMany: async (_, payload) => { update = payload; return { modifiedCount: 1 }; } } });
  const res = { status() { return this; }, json() {} };
  await add({ params: { projectId }, body: { conversationIds: [conversationId] }, user: { _id: userId } }, res);
  const clean = JSON.parse(JSON.stringify(update));
  assert.deepEqual(clean[0].$set.projectPinnedAt, { $cond: [{ $eq: ['$project', projectId] }, { $ifNull: ['$projectPinnedAt', null] }, null] });
  assert.equal('pinnedAt' in clean[0].$set, false);
  const remove = load('removeConversationFromProject.js', { Project: { findOne: async () => project }, ChatConversation: { findOneAndUpdate: async (_, payload) => { update = payload; return { _id: conversationId }; } } });
  await remove({ params: { projectId, conversationId }, user: { _id: userId } }, res);
  assert.deepEqual(JSON.parse(JSON.stringify(update)), { $set: { project: null, projectPinnedAt: null } });
});
