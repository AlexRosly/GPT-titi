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
  modelId = 'files-test-model'; process.env.FILE_OUTPUT_MODELS = 'unrelated-legacy-model';
  delete process.env.FILE_OUTPUT_AUTO_ENABLED;
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

test('automatic file completion recovers without outputFile and charges once', { skip: !uri }, async () => {
  const accepted = await accept({ userId: user._id, payload: { clientMessageId: crypto.randomUUID(), conversationId: conversation.id,
    modelId, message: 'Створи котика у SVG', files: [] } });
  const { turn } = await worker.claimTurn(accepted.turn.turnId);
  const usage = { promptTokens: 20, completionTokens: 20, totalTokens: 40 };
  await models.ChatTurn.updateOne({ turnId: turn.turnId }, { leaseUntil: new Date(0), providerResult: {
    assistantText: 'Cat', usage, artifact: { filename: 'cat.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#none" d="M0 0 L1 1"/></svg>', summary: 'Cat' },
  } });
  await worker.recoverExpired(); await worker.recoverExpired();
  const completed = await models.ChatTurn.findOne({ turnId: turn.turnId });
  const state = await snapshot(completed);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outputFile, null);
  assert.equal(state.assistantMessage.fileResult.status, 'ready');
  const file = await store.read(user._id, state.assistantMessage.attachments[0].fileId);
  assert.match(file.buffer.toString(), /fill="none"/);
  assert.equal(await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }), 1);
  assert.equal(await models.ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 1);
});
test('worker automatically offers files but preserves plain-text streaming', { skip: !uri }, async (t) => {
  await models.ChatModels.updateOne({ modelId }, { $unset: { fileOutputEnabled: 1 } }); // Existing record with no new field.
  const { Completions } = require('openai/resources/chat/completions');
  let calls = 0, fileMode = false;
  t.mock.method(Completions.prototype, 'create', async function* (request) {
    calls++;
    assert.equal(request.tool_choice, 'auto');
    assert.match(request.messages[0].content, /use that tool/);
    if (fileMode) {
      const args = JSON.stringify({ filename: 'natural.txt', content: 'hello from file', summary: 'Ready' });
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'create_file', arguments: args } }] }, finish_reason: 'tool_calls' }] };
    } else yield { choices: [{ delta: { content: 'Hello from chat' }, finish_reason: 'stop' }] };
    yield { choices: [], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } };
  });
  for (const useFile of [false, true]) {
    fileMode = useFile;
    const accepted = await accept({ userId: user._id, payload: { clientMessageId: crypto.randomUUID(), conversationId: conversation.id,
      modelId, message: useFile ? 'Збережи привітання у TXT' : 'Привіт', files: [] } });
    await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
    const state = await snapshot(await models.ChatTurn.findOne({ turnId: accepted.turn.turnId }));
    if (useFile) {
      assert.equal(state.assistantMessage.fileResult.status, 'ready');
      assert.equal((await store.read(user._id, state.assistantMessage.attachments[0].fileId)).buffer.toString(), 'hello from file');
    } else {
      assert.equal(state.assistantMessage.content, 'Hello from chat');
      assert.equal(state.assistantMessage.attachments.length, 0);
    }
    assert.equal(await models.ChatBillingLedger.countDocuments({ turnId: accepted.turn.turnId }), 1);
  }
  assert.equal(calls, 2);
});
test('Office result recovery persists one binary file, preview and charge', { skip: !uri }, async () => {
  const content = JSON.stringify({ sheets: [{ name: 'Дані', rows: [['Товар', 'Сума'], ['Яблука', 42]] }] });
  const { turn } = await fixture(content, 'report.xlsx');
  await models.ChatTurn.updateOne({ turnId: turn.turnId }, { leaseUntil: new Date(0) });
  await worker.recoverExpired(); await worker.recoverExpired();
  const completed = await models.ChatTurn.findOne({ turnId: turn.turnId });
  assert.equal(completed.status, 'completed');
  const state = await snapshot(completed), id = state.assistantMessage.attachments[0].fileId;
  const result = await store.read(user._id, id);
  assert.equal(result.buffer.subarray(0, 2).toString(), 'PK');
  assert.equal(result.file.generatedPreview.kind, 'workbook');
  assert.equal(await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }), 1);
  assert.equal(await models.ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 1);
});
test('invalid document manifest fails explicitly and settles billing once', { skip: !uri }, async () => {
  const { turn, leaseToken, usage } = await fixture('not a document manifest', 'report.pdf');
  const result = await worker.commitCompletion(turn, leaseToken, 'Done', usage);
  assert.equal(result.assistant.fileResult.status, 'failed');
  assert.equal(result.assistant.fileResult.error, 'INVALID_DOCUMENT_JSON');
  assert.equal(await File.countDocuments({ resultKey: `${turn.turnId}:1:0` }), 0);
  assert.equal(await models.ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 1);
});

test('model opt-out blocks explicit output and removes tools from automatic requests', { skip: !uri }, async (t) => {
  const { Completions } = require('openai/resources/chat/completions');
  await models.ChatModels.updateOne({ modelId }, { $set: { fileOutputEnabled: false } });
  try {
    const payload = { clientMessageId: crypto.randomUUID(), conversationId: conversation.id, modelId, message: 'Hello', files: [] };
    await assert.rejects(accept({ userId: user._id, payload: { ...payload, outputFile: { filename: 'blocked.txt' } } }), e => e.protocolError?.code === 'MODEL_NOT_AVAILABLE');
    let calls = 0;
    t.mock.method(Completions.prototype, 'create', async function* (request) {
      calls++;
      assert.equal(request.tools, undefined);
      assert.doesNotMatch(request.messages[0].content, /create_file/);
      yield { choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] };
      yield { choices: [], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } };
    });
    const accepted = await accept({ userId: user._id, payload });
    await worker.processTurn(await worker.claimTurn(accepted.turn.turnId));
    assert.equal(calls, 1);
    assert.equal((await models.ChatTurn.findOne({ turnId: accepted.turn.turnId })).status, 'completed');
  } finally { await models.ChatModels.updateOne({ modelId }, { $unset: { fileOutputEnabled: 1 } }); }
});
