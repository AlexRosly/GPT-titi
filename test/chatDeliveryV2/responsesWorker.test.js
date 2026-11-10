const test = require('node:test');
const assert = require('node:assert/strict');
process.env.OPENAI_API_KEY ||= 'test-placeholder';
const mongoose = require('mongoose');
const { Responses } = require('openai/resources/responses/responses');
const { Completions } = require('openai/resources/chat/completions');
const models = require('../../src/models');
const reservations = require('../../src/services/chatDeliveryV2/reservations');
const charge = require('../../src/services/finalizeCharge');
const { snapshot } = require('../../src/services/chatDeliveryV2/snapshot');
const { additions } = require('../../src/config/modelCatalog202611');

function fixture(t, selected = additions[0]) {
  const doc = { _id: 'turn', turnId: 'turn-id', user: 'owner', conversation: 'conversation-id',
    clientMessageId: 'client-id', modelId: selected.modelId, attempt: 1, status: 'processing', leaseToken: 'lease',
    leaseUntil: new Date(Date.now() + 60000), reservationState: 'held', providerResult: null,
    partialContent: '', lastSeq: 0, providerResponseIds: [], pricing: {}, createdAt: new Date() };
  let assistant, providerCalls = 0, charges = 0, releases = 0;
  const events = [];
  const query = value => ({ lean: async () => value, session: async () => value });
  t.mock.method(mongoose, 'startSession', async () => ({ withTransaction: async fn => fn(), endSession: async () => {} }));
  t.mock.method(models.ChatModels, 'findOne', () => ({ select: () => query({ ...selected, computationEnabled: false, fileOutputEnabled: false }) }));
  t.mock.method(models.ChatTurn, 'findOne', () => query(doc));
  t.mock.method(models.ChatTurn, 'find', async () => doc.status === 'processing' ? [doc] : []);
  t.mock.method(models.ChatTurn, 'updateOne', async (q, update) => {
    if (q.leaseToken && q.leaseToken !== doc.leaseToken || q.cancelRequestedAt === null && doc.cancelRequestedAt) return { matchedCount: 0, modifiedCount: 0 };
    if (q.lastSeq !== undefined) assert.equal(q.lastSeq, doc.lastSeq);
    Object.assign(doc, update.$set);
    if (update.$addToSet?.providerResponseIds) doc.providerResponseIds.push(update.$addToSet.providerResponseIds);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(models.ChatTurn, 'findOneAndUpdate', async (_, update) => { Object.assign(doc, update.$set); return doc; });
  t.mock.method(models.ChatMessage, 'create', async ([value]) => {
    assistant = { _id: 'assistant', ...value, createdAt: new Date(), updatedAt: new Date() };
    return [{ ...assistant, toObject: () => assistant }];
  });
  t.mock.method(models.ChatMessage, 'findById', () => query(assistant));
  t.mock.method(models.ChatConversation, 'updateOne', async () => ({ matchedCount: 1 }));
  t.mock.method(charge, 'finalizeChargeInTransaction', async () => { charges++; return { appTokens: 1, usd: 0.01, balance: 99 }; });
  t.mock.method(reservations, 'release', async (_, __, state = 'released') => { releases++; doc.reservationState = state; });
  t.mock.method(require('../../src/services/tokenLedger'), 'notifyCommitted', () => {});
  t.mock.method(require('../../src/services/files/textContext'), 'forTurn', async () => [{ role: 'user', content: 'Prepared OCR input', attachments: [] }]);
  t.mock.method(require('../../src/services/files/messages'), 'providerContent', async () => 'Prepared OCR input');
  t.mock.method(require('../../src/services/files/messages'), 'hydrate', async (_, values) => values);
  t.mock.method(require('../../src/services/files/exactTranscription'), 'candidates', async () => []);
  t.mock.method(require('../../src/services/computation/policy'), 'availability', () => 'COMPUTE_DISABLED');
  t.mock.method(require('../../src/services/web/context'), 'prepare', async () => null);
  t.mock.method(Completions.prototype, 'create', () => { throw Error('Must not call Chat Completions for a Responses model'); });
  t.mock.method(Responses.prototype, 'create', async function* (request) {
    providerCalls++;
    assert.equal(request.model, selected.modelId);
    assert.match(JSON.stringify(request.input), /Prepared OCR input/);
    yield { type: 'response.created', response: { id: 'resp_test' } };
    yield { type: 'response.output_text.delta', delta: 'Вітаю!' };
    yield { type: 'response.completed', response: { id: 'resp_test', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Вітаю!' }] }],
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } };
  });
  const workerPath = require.resolve('../../src/services/chatDeliveryV2/worker');
  delete require.cache[workerPath];
  const worker = require(workerPath);
  t.after(() => delete require.cache[workerPath]);
  worker.setIo({ to: user => ({ emit: (name, value) => events.push({ user, name, value }) }) });
  return { doc, worker, events, counts: () => ({ providerCalls, charges, releases }) };
}

for (const selected of additions) test(`${selected.modelId}: V2 identity/seq, actual usage, status/F5 and one completion charge`, async t => {
  const f = fixture(t, selected);
  await f.worker.processTurn({ turn: f.doc, leaseToken: 'lease' });
  assert.equal(f.doc.status, 'completed');
  assert.equal(f.doc.usage.totalTokens, 16);
  assert.deepEqual(f.doc.providerResponseIds, ['resp_test']);
  const delta = f.events.find(e => e.name === 'chat:stream').value;
  assert.equal(delta.turnId, 'turn-id');
  assert.equal(delta.clientMessageId, 'client-id');
  assert.equal(delta.attempt, 1);
  assert.equal(delta.payload.seq, 1);
  assert.equal(f.events.filter(e => e.name === 'chat:end').length, 1);
  const restored = await snapshot(f.doc);
  assert.equal(restored.status, 'completed');
  assert.equal(restored.assistantMessage.content, 'Вітаю!');
  await f.worker.recoverExpired();
  assert.deepEqual(f.counts(), { providerCalls: 1, charges: 1, releases: 1 });
});

test('provider EOF creates an error, keeps uncertain hold and never emits successful chat:end', async t => {
  const f = fixture(t);
  t.mock.method(Responses.prototype, 'create', async function* () {
    yield { type: 'response.created', response: { id: 'resp_uncertain' } };
    yield { type: 'response.output_text.delta', delta: 'partial' };
  });
  await f.worker.processTurn({ turn: f.doc, leaseToken: 'lease' });
  assert.equal(f.doc.status, 'failed');
  assert.equal(f.doc.needsReconciliation, true);
  assert.equal(f.doc.reservationState, 'held');
  assert.equal(f.events.some(e => e.name === 'chat:end'), false);
  assert.equal(f.counts().charges, 0);
});

test('unavailable model returns MODEL_NOT_AVAILABLE without hidden fallback or charge', async t => {
  const f = fixture(t);
  t.mock.method(Responses.prototype, 'create', async () => { throw Object.assign(Error('Not found'), { status: 404 }); });
  await f.worker.processTurn({ turn: f.doc, leaseToken: 'lease' });
  assert.equal(f.doc.status, 'failed');
  assert.equal(f.doc.error.code, 'MODEL_NOT_AVAILABLE');
  assert.equal(f.doc.reservationState, 'released');
  assert.equal(f.counts().charges, 0);
});

test('persisted final result recovers without any request to the model', async t => {
  const f = fixture(t);
  f.doc.providerResult = { assistantText: 'Durable answer', usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } };
  f.doc.leaseUntil = new Date(0);
  await f.worker.recoverExpired();
  assert.equal(f.doc.status, 'completed');
  assert.deepEqual(f.counts(), { providerCalls: 0, charges: 1, releases: 1 });
});

test('cancel persisted before a worker crash terminates without replaying or committing a partial tool workflow', async t => {
  const f = fixture(t);
  f.doc.leaseUntil = new Date(0);
  f.doc.cancelRequestedAt = new Date();
  f.doc.providerStartedAt = new Date();
  f.doc.responseState = { pending: false, calls: 1, usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
    partialData: { assistantText: 'Intermediate tool step' } };
  await f.worker.recoverExpired();
  assert.equal(f.doc.status, 'failed');
  assert.equal(f.doc.needsReconciliation, true);
  assert.deepEqual(f.counts(), { providerCalls: 0, charges: 0, releases: 0 });
  assert.equal(f.events.some(e => e.name === 'chat:end'), false);
});

test('user cancel aborts the live provider signal and terminates the V2 turn', async t => {
  const f = fixture(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  t.mock.method(Responses.prototype, 'create', async function* (_, { signal }) {
    yield { type: 'response.created', response: { id: 'resp_cancel' } };
    entered();
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    signal.throwIfAborted();
  });
  const processing = f.worker.processTurn({ turn: f.doc, leaseToken: 'lease' });
  await started;
  f.worker.abortTurn('turn-id');
  await processing;
  assert.equal(f.doc.status, 'failed');
  assert.equal(f.events.some(e => e.name === 'chat:error'), true);
  assert.equal(f.events.some(e => e.name === 'chat:end'), false);
  assert.equal(f.doc.needsReconciliation, true);
});

test('document checkpoint recovery retains document status without a provider replay or second charge',async t=>{
  const f=fixture(t),usage={promptTokens:12,completionTokens:4,totalTokens:16};
  f.doc.leaseUntil=new Date(0);
  f.doc.responseState={pending:false,calls:1,usage,partialData:{assistantText:'Inspection completed.'}};
  f.doc.computeState={kind:'document',pending:false,calls:1,runs:1,executionMs:40,usage,files:[]};
  await f.worker.recoverExpired();
  const restored=await snapshot(f.doc);
  assert.equal(restored.assistantMessage.computation.kind,'document');
  assert.equal(restored.assistantMessage.computation.status,'partial');
  assert.equal(restored.assistantMessage.computation.reason,'PROCESS_INTERRUPTED');
  await f.worker.recoverExpired();
  assert.deepEqual(f.counts(),{providerCalls:0,charges:1,releases:1});
});
