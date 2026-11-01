const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const rules = require('../src/services/pinning/pinningRules');

// Run real Mongoose query construction, casting and middleware, stubbing only
// the MongoDB collection transport. No live database or credentials required.
const projectId = new mongoose.Types.ObjectId();
const conversationId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
function fixture(file, transport) {
  const connection = mongoose.createConnection();
  const schema = new mongoose.Schema({
    user: mongoose.Schema.Types.ObjectId,
    project: mongoose.Schema.Types.ObjectId,
    archived: Boolean,
    pinnedAt: Date,
    projectPinnedAt: Date,
  }, { timestamps: true, bufferCommands: false });
  const model = connection.model('ProjectPinPipelineRegression', schema);
  Object.assign(model.collection, transport);
  const project = { _id: projectId, save: async () => {} };
  const sandbox = {
    module: { exports: {} }, Date, console: { error() {} },
    require(id) {
      if (id === 'mongoose') return mongoose;
      if (id === '../../services/pinning') return rules;
      if (id === '../../models') return {
        Project: { exists: async () => true, findOne: async () => project },
        ChatConversation: model,
      };
      throw Error(id);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../src/controllers/projects', file), 'utf8'), sandbox);
  return async (body) => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await sandbox.module.exports({ params: { projectId: String(projectId), conversationId: String(conversationId) }, user: { _id: userId }, body }, res);
    return res;
  };
}

test('project pin and unpin reach MongoDB through real Mongoose without changing global pin or timestamps', async () => {
  const calls = [];
  const request = fixture('updateProjectConversationPin.js', {
    async findOneAndUpdate(filter, update) {
      calls.push({ filter, update });
      return { _id: conversationId, projectPinnedAt: update[0].$set.projectPinnedAt === null ? null : new Date('2026-01-01') };
    },
  });
  for (const pinned of [true, false]) {
    const res = await request({ pinned });
    assert.equal(res.code, 200);
    assert.equal(res.body.projectPinnedAt === null, !pinned);
  }
  assert.equal(calls.length, 2);
  for (const { filter, update } of calls) {
    assert.equal(String(filter.user), String(userId));
    assert.equal(String(filter.project), String(projectId));
    assert.equal(filter.archived, false);
    assert.deepEqual(JSON.parse(JSON.stringify(update)).map(stage => Object.keys(stage.$set)), [['projectPinnedAt']]);
  }
});

test('adding project conversations reaches MongoDB through real Mongoose and preserves scoped pin expression', async () => {
  let payload;
  const request = fixture('addConversationsToProject.js', {
    async updateMany(filter, update) {
      assert.equal(String(filter.user), String(userId));
      assert.equal(filter.archived, false);
      payload = JSON.parse(JSON.stringify(update));
      return { modifiedCount: 1 };
    },
  });
  const res = await request({ conversationIds: [String(conversationId)] });
  assert.equal(res.code, 200);
  assert.equal(res.body.modified, 1);
  assert.deepEqual(payload[0].$set.projectPinnedAt, {
    $cond: [{ $eq: ['$project', String(projectId)] }, { $ifNull: ['$projectPinnedAt', null] }, null],
  });
  assert.equal(payload[0].$set.project, String(projectId));
  assert.equal(payload.some(stage => 'pinnedAt' in stage.$set), false);
});
