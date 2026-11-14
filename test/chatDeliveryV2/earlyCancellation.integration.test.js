require('dotenv').config({ quiet: true });
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const uri = process.env.CHAT_V2_TEST_MONGO_URI;
if (!uri) test('early Stop settlement requires a disposable replica set', { skip: true }, () => {});
else {
  process.env.OPENAI_API_KEY ||= 'test-placeholder';
  const { User, ChatTurn, ChatModels, ChatMessage, ChatConversation, ChatBillingLedger, TokenOperation, BalanceOutbox } = require('../../src/models');
  const Job = require('../../src/models/documentJob');
  const ledger = require('../../src/services/tokenLedger');
  const worker = require('../../src/services/chatDeliveryV2/worker');
  const cancel = require('../../src/services/chatDeliveryV2/cancelTurn');
  const repair = require('../../src/services/chatDeliveryV2/reconcileEarlyCancellation');
  const early = require('../../src/services/chatDeliveryV2/earlyCancellation');
  const { errorFor } = require('../../src/services/chatDeliveryV2/protocol');
  const usage = { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 };
  const snapshot = async id => ({ user: await User.findById(id).lean(), turns: await ChatTurn.find({ user: id }).lean(),
    bills: await ChatBillingLedger.find({ user: id }).lean(), ops: await TokenOperation.find({ 'entries.user': id }).lean(),
    outbox: await BalanceOutbox.find({ user: id }).lean() });
  test.before(async () => {
    await mongoose.connect(uri, { dbName: `gpt_titi_test_cancel_${crypto.randomBytes(4).toString('hex')}` });
    for (const m of [User, ChatTurn, ChatModels, ChatMessage, ChatConversation, ChatBillingLedger, TokenOperation, BalanceOutbox, Job]) await m.createIndexes();
  });
  test.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  async function transaction(fn) {
    const session = await mongoose.startSession();
    try { return await session.withTransaction(() => fn(session)); }
    finally { await session.endSession(); }
  }
  async function fixture() {
    const user = await User.create({ email: crypto.randomUUID() + '@example.test', appTokens: 100000, status: 'active' });
    const modelId = crypto.randomUUID();
    await ChatModels.create({ modelId, enabled: true, category: 'chat', computationEnabled: false,
      fileOutputEnabled: false, inputPerM: 1, outputPerM: 2 });
    const conversation = await ChatConversation.create({ user: user._id, modelId, title: 'Stop fixture' });
    const userMessage = await ChatMessage.create({ user: user._id, conversation: conversation._id,
      role: 'user', content: 'private test prompt', modelId });
    const turn = await ChatTurn.create({ turnId: crypto.randomUUID(), user: user._id, conversation: conversation._id,
      userMessage: userMessage._id, clientMessageId: crypto.randomUUID(), requestHash: 'hash', modelId, message: 'private test prompt',
      status: 'queued', reservationState: 'held', reservedAppTokens: 2357, providerConfig: { apiMode: 'chat_completions' },
      pricing: { inputPerM: 1, outputPerM: 2, tokenValueUsd: .00001 } });
    await transaction(session => ledger.changeReservation({ userId: user._id, amount: 2357, turnId: turn.turnId, attempt: 1, session }));
    return { user, turn };
  }
  async function interrupted(change = {}) {
    const f = await fixture(), claimed = await worker.claimTurn(f.turn.turnId);
    await ChatTurn.updateOne({ _id: f.turn._id }, { $set: {
      providerStartedAt: new Date(), cancelRequestedAt: new Date(), ...change } });
    return { ...f, claimed };
  }
  function policy(t, value) {
    const old = process.env.CHAT_EARLY_CANCEL_UNKNOWN_USAGE_POLICY;
    process.env.CHAT_EARLY_CANCEL_UNKNOWN_USAGE_POLICY = value;
    t.after(() => { if (old === undefined) delete process.env.CHAT_EARLY_CANCEL_UNKNOWN_USAGE_POLICY;
      else process.env.CHAT_EARLY_CANCEL_UNKNOWN_USAGE_POLICY = old; });
  }
  async function failedLegacy() {
    const f = await fixture();
    await ChatTurn.updateOne({ _id: f.turn._id }, { $set: { status: 'failed', providerStartedAt: new Date(),
      cancelRequestedAt: new Date(), needsReconciliation: true,
      error: errorFor('PROCESS_INTERRUPTED'), failureDiagnostic: { terminal: { code: 'USER_CANCELLED' } } } });
    return f;
  }
  test('manual mode preserves cancellation cause and holds unknown usage honestly', async t => {
    policy(t, 'manual'); const f = await interrupted();
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, errorFor('USER_CANCELLED'));
    const done = await ChatTurn.findById(f.turn._id);
    assert.equal(done.error.code, 'USER_CANCELLED'); assert.match(done.error.message, /needs review/);
    assert.equal(done.needsReconciliation, true); assert.equal(done.reservationState, 'held');
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, 2357);
  });
  test('opt-in covers unknown early cost, releases once, and preserves an unrelated hold', async t => {
    policy(t, early.COVER_UNKNOWN); const f = await interrupted();
    await transaction(session => ledger.changeReservation({ userId: f.user._id, amount: 777,
      turnId: crypto.randomUUID(), attempt: 1, session }));
    await Promise.all([worker.failTurn(f.claimed.turn, f.claimed.leaseToken, errorFor('USER_CANCELLED')),
      worker.failTurn(f.claimed.turn, f.claimed.leaseToken, errorFor('USER_CANCELLED'))]);
    const done = await ChatTurn.findById(f.turn._id), user = await User.findById(f.user._id);
    assert.equal(done.error.code, 'USER_CANCELLED'); assert.equal(done.needsReconciliation, false);
    assert.equal(done.reconciliation.platformCoversUnknown, true); assert.equal(done.reconciliation.providerUsageKnown, false);
    assert.equal(done.reconciliation.noCharge, undefined);
    assert.equal(user.appTokens, 100000); assert.equal(user.reservedAppTokens, 777);
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: done.turnId }), 0);
    assert.equal(await TokenOperation.countDocuments({ 'context.turnId': done.turnId, kind: 'reservation_release' }), 1);
    assert.equal((await require('../../src/services/chatDeliveryV2/snapshot').snapshot(done)).cancelRequested, true);
  });
  test('confirmed provider usage settles exactly once even with the coverage policy disabled', async t => {
    policy(t, 'manual'); const f = await interrupted({ initialProviderUsage: usage });
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, errorFor('USER_CANCELLED'));
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, errorFor('USER_CANCELLED'));
    const done = await ChatTurn.findById(f.turn._id), user = await User.findById(f.user._id);
    assert.equal(done.billing.appTokensSpent, 140); assert.equal(user.appTokens, 99860);
    assert.equal(user.reservedAppTokens, 0); assert.equal(done.reservationState, 'settled');
    assert.equal(done.reconciliation.providerUsageKnown, true); assert.equal(done.reconciliation.platformCoversUnknown, false);
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: done.turnId }), 1);
    assert.equal(await TokenOperation.countDocuments({ 'context.turnId': done.turnId, kind: 'chat_charge' }), 1);
  });
  test('persisted usage and cancellation survive worker loss without another provider call', async t => {
    policy(t, 'manual'); const f = await interrupted({ initialProviderUsage: usage, leaseUntil: new Date(0) });
    await worker.recoverExpired();
    const done = await ChatTurn.findById(f.turn._id);
    assert.equal(done.error.code, 'USER_CANCELLED'); assert.equal(done.billing.appTokensSpent, 140);
    assert.equal(done.needsReconciliation, false);
  });
  test('actual stream cancellation before the first chunk releases under the opt-in policy', async t => {
    policy(t, early.COVER_UNKNOWN); const f = await fixture();
    const { Completions } = require('openai/resources/chat/completions'); let calls = 0;
    t.mock.method(Completions.prototype, 'create', async function* (_request, options) {
      calls++; await cancel({ turnId: f.turn.turnId, userId: f.user._id });
      options.signal.throwIfAborted();
    });
    await worker.processTurn(await worker.claimTurn(f.turn.turnId));
    const done = await ChatTurn.findById(f.turn._id);
    assert.equal(calls, 1); assert.equal(done.error.code, 'USER_CANCELLED');
    assert.equal(done.reservationState, 'released'); assert.equal(done.needsReconciliation, false);
    assert.equal(await Job.countDocuments({ turnId: done.turnId }), 0);
  });
  test('usage at the stream boundary is durable before cancellation and is billed once', async t => {
    policy(t, 'manual'); const f = await fixture();
    const { Completions } = require('openai/resources/chat/completions');
    t.mock.method(Completions.prototype, 'create', async function* (_request, options) {
      yield { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } };
      assert.deepEqual((await ChatTurn.findById(f.turn._id).lean()).initialProviderUsage, usage);
      await cancel({ turnId: f.turn.turnId, userId: f.user._id });
      options.signal.throwIfAborted();
    });
    await worker.processTurn(await worker.claimTurn(f.turn.turnId));
    const done = await ChatTurn.findById(f.turn._id);
    assert.equal(done.billing.appTokensSpent, 140); assert.equal(done.needsReconciliation, false);
  });
  for (const [name, changes] of [
    ['delivered answer', { partialContent: 'Already delivered text', lastSeq: 1 }],
    ['compute continuation', { computeState: { pending: true, usage } }],
    ['Responses continuation', { responseState: { pending: true, usage }, providerConfig: { apiMode: 'responses' } }],
    ['browser continuation', { browserState: { pending: true, usage } }],
    ['malformed saved usage', { initialProviderUsage: { totalTokens: 100 } }],
  ]) test(`never absorbs uncertain cost for ${name}`, async t => {
    policy(t, early.COVER_UNKNOWN); const f = await interrupted(changes);
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, errorFor('USER_CANCELLED'));
    const done = await ChatTurn.findById(f.turn._id);
    assert.equal(done.needsReconciliation, true); assert.equal(done.reservationState, 'held');
    assert.equal(done.error.code, 'USER_CANCELLED');
  });
  test('active background document ownership is not touched by cancellation settlement', async t => {
    policy(t, early.COVER_UNKNOWN); const f = await interrupted({ computeState: { documentJob: { active: true } } });
    const before = await snapshot(f.user._id);
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, errorFor('USER_CANCELLED'));
    assert.deepEqual(await snapshot(f.user._id), before);
  });
  test('provider failure without user cancellation retains the original reconciliation policy', async t => {
    policy(t, early.COVER_UNKNOWN); const f = await interrupted({ cancelRequestedAt: null });
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, errorFor('PROVIDER_UNAVAILABLE'));
    const done = await ChatTurn.findById(f.turn._id);
    assert.equal(done.error.code, 'PROCESS_INTERRUPTED'); assert.equal(done.reservationState, 'held');
  });
  test('legacy T9 plan is read only; explicit concurrent application releases exactly 2357 once', async () => {
    const f = await failedLegacy(), before = await snapshot(f.user._id), p = await repair.plan({ turnId: f.turn.turnId, attempt: 1 });
    assert.equal(p.entry.releaseTokens, 2357); assert.equal(p.entry.userChargeTokens, 0);
    assert.equal(p.entry.providerUsageKnown, false); assert.deepEqual(await snapshot(f.user._id), before);
    await assert.rejects(repair.apply(p), { code: 'CANCEL_POLICY_ACK_REQUIRED' });
    const results = await Promise.all([repair.apply(p, { platformCoversUnknown: true }), repair.apply(p, { platformCoversUnknown: true })]);
    assert.equal(results.reduce((n, r) => n + r.releasedTokens, 0), 2357);
    const after = await snapshot(f.user._id);
    assert.equal(after.user.appTokens, 100000); assert.equal(after.user.reservedAppTokens, 0);
    assert.equal(after.turns[0].error.code, 'USER_CANCELLED');
    assert.equal(after.bills.length, 0); assert.equal(after.ops.filter(o => o.kind === 'reservation_release').length, 1);
    assert.equal((await repair.apply(p, { platformCoversUnknown: true })).alreadyApplied, true);
    assert.deepEqual(await snapshot(f.user._id), after);
  });
  test('stale or altered plans cannot change a balance', async () => {
    const f = await failedLegacy(), p = await repair.plan({ turnId: f.turn.turnId, attempt: 1 });
    const before = await snapshot(f.user._id);
    await assert.rejects(repair.apply({ ...p, entry: { ...p.entry, releaseTokens: 9999 } }, { platformCoversUnknown: true }), { code: 'CANCEL_PLAN_STALE' });
    assert.deepEqual(await snapshot(f.user._id), before);
    await ChatTurn.updateOne({ _id: f.turn._id }, { $set: { partialContent: 'Delivered elsewhere' } });
    await assert.rejects(repair.apply(p, { platformCoversUnknown: true }), { code: 'CANCEL_UNSAFE_TURN' });
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, 2357);
  });
  test('an outbox failure rolls back release and audit together', async t => {
    const f = await failedLegacy(), p = await repair.plan({ turnId: f.turn.turnId, attempt: 1 }), before = await snapshot(f.user._id);
    const original = BalanceOutbox.create.bind(BalanceOutbox);
    t.mock.method(BalanceOutbox, 'create', (items, ...args) => {
      if (items.some(i => i.reason === 'reservation_release')) throw new Error('Simulated outbox failure');
      return original(items, ...args);
    });
    await assert.rejects(repair.apply(p, { platformCoversUnknown: true }), /outbox failure/);
    assert.deepEqual(await snapshot(f.user._id), before);
  });
  test('existing charge or missing hold receipt cannot be silently repaired', async () => {
    const f = await failedLegacy();
    await TokenOperation.deleteOne({ 'context.turnId': f.turn.turnId });
    await assert.rejects(repair.plan({ turnId: f.turn.turnId, attempt: 1 }), { code: 'CANCEL_HOLD_MISMATCH' });
    await ChatBillingLedger.create({ turnId: f.turn.turnId, user: f.user._id, modelId: f.turn.modelId,
      appTokensSpent: 10, totalTokens: 100, usd: .0001, balance: 99990 });
    await assert.rejects(repair.plan({ turnId: f.turn.turnId, attempt: 1 }), { code: 'CANCEL_EXISTING_CHARGE' });
  });
  test('a persisted Stop remains a cancellation when another worker aborts without a local reason', async t => {
    policy(t, early.COVER_UNKNOWN); const f = await interrupted();
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, errorFor('INTERNAL_ERROR'));
    const done = await ChatTurn.findById(f.turn._id);
    assert.equal(done.error.code, 'USER_CANCELLED'); assert.equal(done.reservationState, 'released');
    assert.equal(done.failureDiagnostic.terminal.code, 'USER_CANCELLED');
  });
  test('provider-confirmed zero usage is recorded as known, not a platform waiver', async t => {
    policy(t, 'manual'); const f = await interrupted({ initialProviderUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, errorFor('USER_CANCELLED'));
    const done = await ChatTurn.findById(f.turn._id);
    assert.equal(done.billing.appTokensSpent, 0); assert.equal(done.reconciliation.providerUsageKnown, true);
    assert.equal(done.reconciliation.platformCoversUnknown, false); assert.equal(done.needsReconciliation, false);
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, 0);
  });
  test('confirmed usage without its price snapshot is held for review, never repriced or waived', async t => {
    policy(t, early.COVER_UNKNOWN); const f = await interrupted({ initialProviderUsage: usage, pricing: null });
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, errorFor('USER_CANCELLED'));
    assert.equal((await ChatTurn.findById(f.turn._id)).reservationState, 'held');
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: f.turn.turnId }), 0);
  });
  test('CLI previews the exact target and requires explicit policy acknowledgement for application', async () => {
    const f = await failedLegacy(), before = await snapshot(f.user._id);
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'early-stop-plan-'));
    try {
      const parsed = new URL(uri); parsed.pathname = '/' + mongoose.connection.name;
      const options = { cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 20000,
        env: { ...process.env, CHAT_RECONCILIATION_MONGO_URI: parsed.toString() } };
      const output = execFileSync(process.execPath,
        ['scripts/reconcileEarlyCancellation.js', '--plan', f.turn.turnId, '1'], options);
      const p = JSON.parse(output); assert.equal(p.entry.releaseTokens, 2357);
      assert.deepEqual(await snapshot(f.user._id), before);
      assert.doesNotMatch(output, /private test prompt|example.test|mongodb:/);
      const file = path.join(dir, 'plan.json'); fs.writeFileSync(file, output);
      assert.throws(() => execFileSync(process.execPath,
        ['scripts/reconcileEarlyCancellation.js', '--apply', file], { ...options, stdio: 'pipe' }));
      assert.deepEqual(await snapshot(f.user._id), before);
      const applied = JSON.parse(execFileSync(process.execPath,
        ['scripts/reconcileEarlyCancellation.js', '--apply', file, '--platform-covers-unknown'], options));
      assert.equal(applied.releasedTokens, 2357); assert.equal(applied.userChargeTokens, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

}
