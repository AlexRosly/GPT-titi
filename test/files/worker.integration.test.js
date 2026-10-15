const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const uri = process.env.FILES_TEST_MONGO_URI;
// No real provider request is made by these tests.
process.env.OPENAI_API_KEY ||= 'test-placeholder-not-a-real-key';
const models = require('../../src/models');
const File = require('../../src/models/managedFile');
const Chunk = require('../../src/models/fileChunk');
const Quota = require('../../src/models/fileQuota');
const worker = require('../../src/services/chatDeliveryV2/worker');
const accept = require('../../src/services/chatDeliveryV2/acceptTurn');
const store = require('../../src/services/files/store');
const { snapshot } = require('../../src/services/chatDeliveryV2/snapshot');
let user, conversation, modelId;
test.before(async () => {
  if (!uri) return;
  if (!/\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri)) throw new Error('Isolated test DB required');
  await mongoose.connect(uri.replace('gptiti_files_test_local', 'gptiti_files_test_worker'));
  for (const m of [...Object.values(models), File, Chunk, Quota]) await m.createIndexes();
  process.env.PRIVATE_FILES_ENABLED = 'true';
  modelId = 'files-test-model'; process.env.FILE_OUTPUT_MODELS = modelId;
  user = await models.User.create({ email: 'worker-files@example.test', name: 'Files', status: 'active', appTokens: 100000 });
  await models.ChatModels.create({ modelId, enabled: true, inputPerM: 1, outputPerM: 2 });
  conversation = await models.ChatConversation.create({ user: user._id, modelId });
});
test.after(async () => { if (uri) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
const fixture = async (content, filename = 'result.txt') => {
  const accepted = await accept({ userId: user._id, payload: { clientMessageId: crypto.randomUUID(), conversationId: conversation.id,
    modelId, message: 'Create a file', files: [], outputFile: { filename } } });
  const claim = await worker.claimTurn(accepted.turn.turnId);
  const usage = { promptTokens: 20, completionTokens: 20, totalTokens: 40 };
  await models.ChatTurn.updateOne({ turnId: claim.turn.turnId }, { providerResult: { assistantText: 'Done', usage, artifact: { content, summary: 'Result' } } });
  return { ...claim, usage };
};
test('completion commits real file and V2 references, recovery never duplicates file or charge', { skip: !uri }, async () => {
  const { turn, leaseToken, usage } = await fixture('hello');
  const completion = await worker.commitCompletion(turn, leaseToken, 'Done', usage);
  const id = completion.assistant.attachments[0].fileId;
  assert.equal((await store.read(user._id, id)).buffer.toString(), 'hello');
  const recovered = await snapshot(await models.ChatTurn.findOne({ turnId: turn.turnId }));
  assert.equal(recovered.assistantMessage.attachments[0].fileId, id);
  await worker.recoverExpired();
  assert.equal(await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }), 1);
  assert.equal(await models.ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 1);
  await store.remove(user._id, id);
  const deleted = await snapshot(await models.ChatTurn.findOne({ turnId: turn.turnId }));
  assert.equal(deleted.assistantMessage.fileResult.status, 'deleted');
});
test('invalid model output completes billing once and returns explicit file failure', { skip: !uri }, async () => {
  const { turn, leaseToken, usage } = await fixture('{not json}', 'result.json');
  const result = await worker.commitCompletion(turn, leaseToken, 'Done', usage);
  assert.equal(result.assistant.fileResult.status, 'failed');
  assert.equal(result.assistant.fileResult.error, 'INVALID_JSON');
  assert.equal(result.assistant.attachments.length, 0);
  assert.equal(await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }), 0);
  assert.equal(await models.ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 1);
});
test('expired worker result is finalized from saved output without another provider request', { skip: !uri }, async () => {
  const { turn } = await fixture('recovered content');
  await models.ChatTurn.updateOne({ turnId: turn.turnId }, { leaseUntil: new Date(0) });
  await worker.recoverExpired();
  const completed = await models.ChatTurn.findOne({ turnId: turn.turnId });
  assert.equal(completed.status, 'completed');
  assert.equal(await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }), 1);
});
