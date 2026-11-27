require('dotenv').config({ quiet: true });
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const uri = process.env.CHAT_V2_TEST_MONGO_URI;

if (!uri) test('failed hold integration requires a test replica set', { skip: true }, () => {});
else {
  process.env.OPENAI_API_KEY ||= 'test-unused';
  const mongoose = require('mongoose');
  const { User, ChatTurn, ChatModels, ChatMessage, ChatConversation, ChatBillingLedger, TokenOperation, BalanceOutbox } = require('../../src/models');
  const DocumentJob = require('../../src/models/documentJob');
  const worker = require('../../src/services/chatDeliveryV2/worker');
  const { errorFor } = require('../../src/services/chatDeliveryV2/protocol');
  const accept = require('../../src/services/chatDeliveryV2/acceptTurn');
  const retry = require('../../src/services/chatDeliveryV2/retryTurn');
  const ledger = require('../../src/services/tokenLedger');
  const { confirmedUsage, SOURCE } = require('../../src/services/chatDeliveryV2/failedHold');
  const { run } = require('../../scripts/reconcileFailedHold');
  const held = 21949;
  const usage = { promptTokens: 3000, completionTokens: 500, totalTokens: 3500 };
  const first = { promptTokens: 2000, completionTokens: 100, totalTokens: 2100 };
  const interrupted = errorFor('PROCESS_INTERRUPTED');
  test.before(async () => {
    await mongoose.connect(uri, { dbName: 'gpt_titi_test_holds_' + crypto.randomBytes(6).toString('hex') });
    for (const model of [User, ChatTurn, ChatModels, ChatMessage, ChatConversation, ChatBillingLedger, TokenOperation, BalanceOutbox, DocumentJob]) await model.createIndexes();
  });
  test.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  async function fixture(fields = {}, legacy = true) {
    const modelId = crypto.randomUUID();
    const user = await User.create({ email: modelId + '@example.test', status: 'active', appTokens: 100000 });
    await ChatModels.create({ modelId, label: 'Test', category: 'chat', enabled: true, inputPerM: 1, outputPerM: 2 });
    const conversation = await ChatConversation.create({ user: user._id, modelId, title: 'Test' });
    const send = () => accept({ userId: user._id, payload: { clientMessageId: crypto.randomUUID(),
      conversationId: String(conversation._id), modelId, message: 'private test request' } });
    const { turn } = await send();
    const claimed = await worker.claimTurn(turn.turnId);
    await mongoose.connection.transaction(async session => {
      await ledger.increaseWebReservation({ userId: user._id, amount: held - turn.reservedAppTokens,
        turnId: turn.turnId, attempt: 1, phase: 1, session });
      await ChatTurn.updateOne({ _id: turn._id }, { $set: { reservedAppTokens: held, providerStartedAt: new Date(),
        ...(legacy ? { status: 'failed', leaseToken: null, leaseUntil: null, needsReconciliation: true, error: interrupted } : {}),
        ...fields } }, { session });
    });
    return { turn, user, send, claimed, target: { turnId: turn.turnId, attempt: 1, heldTokens: held } };
  }

  test('CLI plans and applies one historical hold with no usage, and a second plan and apply make zero changes', async () => {
    const { turn, user, target } = await fixture();
    const mongo = new URL(uri);
    mongo.pathname = '/' + mongoose.connection.name;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'failed-hold-'));
    const file = path.join(dir, 'plan.json');
    const invoke = async args => JSON.parse((await promisify(execFile)(process.execPath,
      ['scripts/reconcileFailedHold.js', ...args], { cwd: path.join(__dirname, '../..'),
        env: { ...process.env, CHAT_RECONCILIATION_MONGO_URI: mongo.toString() } })).stdout);
    const args = ['--plan', target.turnId, '1', String(held)];
    try {
      const plan = await invoke(args);
      assert.equal(plan.entry.usage, null);
      assert.equal(plan.entry.platformCoversUnknown, true);
      assert.equal(plan.projectedReservedTokens, 0);
      assert.equal(plan.availableIncrease, held);
      assert.equal((await User.findById(user._id)).reservedAppTokens, held);
      assert.doesNotMatch(JSON.stringify(plan), /private test request|mongodb:|@example/);
      await fs.writeFile(file, JSON.stringify(plan));
      const apply = ['--apply', file, '--platform-covers-unknown'];
      const result = await invoke(apply);
      assert.equal(result.releasedThisRun, held); assert.equal(result.chargedThisRun, 0);
      assert.equal(result.balanceAfter.appTokens, 100000); assert.equal(result.balanceAfter.reservedAppTokens, 0);
      for (const again of [await invoke(args), await invoke(apply)]) {
        assert.equal(again.alreadyApplied, true); assert.equal(again.chargedThisRun, 0); assert.equal(again.releasedThisRun, 0);
      }
      assert.equal(await ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 0);
      assert.equal(await TokenOperation.countDocuments({ 'context.turnId': turn.turnId, kind: 'reservation_release' }), 1);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  test('concurrent repairs charge completed calls once, cover pending usage and preserve an unrelated hold', async () => {
    const f = await fixture({ browserState: { pending: true, calls: 3, usage }, initialProviderUsage: first });
    const other = await f.send();
    const p = await run(f.target);
    assert.equal(p.entry.userChargeTokens, 400);
    assert.deepEqual(p.entry.usage, usage);
    assert.equal(p.entry.usageSource, 'browserState'); assert.equal(p.entry.providerUsageKnown, false);
    const results = await Promise.all([run(f.target, p), run(f.target, p)]);
    assert.equal(results.filter(r => r.alreadyApplied).length, 1);
    assert.equal(results.reduce((n, r) => n + r.chargedThisRun, 0), 400);
    assert.equal(results.reduce((n, r) => n + r.releasedThisRun, 0), held);
    const account = await ledger.getBalance(f.user._id);
    assert.equal(account.appTokens, 99600); assert.equal(account.reservedAppTokens, other.turn.reservedAppTokens);
    assert.equal(account.availableTokens, 99600 - other.turn.reservedAppTokens);
    assert.equal((await ChatTurn.findById(other.turn._id)).reservationState, 'held');
    assert.equal(await BalanceOutbox.countDocuments({ user: f.user._id, reason: 'reservation_release' }), 1);
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: f.turn.turnId }), 1);
    assert.equal((await ChatTurn.findById(f.turn._id)).status, 'failed');
  });

  function enableCoverage(t) {
    const old = process.env.CHAT_FAILED_HOLD_POLICY;
    process.env.CHAT_FAILED_HOLD_POLICY = 'platform_covers_unknown';
    t.after(() => { if (old === undefined) delete process.env.CHAT_FAILED_HOLD_POLICY; else process.env.CHAT_FAILED_HOLD_POLICY = old; });
  }

  test('interrupted live stream without final usage closes its reservation without replaying the provider', async t => {
    enableCoverage(t);
    const f = await fixture({ providerStartedAt: null }, false);
    const { Completions } = require('openai/resources/chat/completions');
    let requests = 0;
    t.mock.method(Completions.prototype, 'create', async function* () {
      requests++;
      yield { choices: [{ delta: { content: 'Partial answer.' } }] };
      throw new Error('Interrupted provider stream');
    });
    await worker.processTurn(f.claimed);
    const closed = await ChatTurn.findById(f.turn._id);
    assert.equal(requests, 1); assert.equal(closed.status, 'failed');
    assert.equal(closed.needsReconciliation, false); assert.equal(closed.reservationState, 'released');
    assert.equal(closed.reconciliation.platformCoversUnknown, true);
    assert.equal((await ledger.getBalance(f.user._id)).availableTokens, 100000);
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: f.turn.turnId }), 0);
  });

  test('a persisted cancellation with known earlier usage closes under the failed-hold policy', async t => {
    enableCoverage(t);
    const f = await fixture({ cancelRequestedAt: new Date(), browserState: { pending: true, calls: 3, usage } }, false);
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, interrupted);
    const closed = await ChatTurn.findById(f.turn._id);
    assert.equal(closed.error.code, 'USER_CANCELLED');
    assert.equal(closed.reconciliation.platformCoversUnknown, true);
    assert.equal(closed.billing.appTokensSpent, 400);
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, 0);
  });

  test('a worker with damaged billing evidence still marks the turn failed and records the review reason', async t => {
    enableCoverage(t);
    const f = await fixture({ initialProviderUsage: { ...usage, totalTokens: 1 } }, false);
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, interrupted);
    const closed = await ChatTurn.findById(f.turn._id);
    assert.equal(closed.status, 'failed'); assert.equal(closed.reservationState, 'held');
    assert.equal(closed.failureDiagnostic.terminal.holdReview, 'INVALID_INITIAL_USAGE');
    assert.equal(closed.needsReconciliation, true);
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, held);
  });

  test('enabled worker settles a new failed attempt and crash recovery of an unknown call closes once', async t => {
    enableCoverage(t);
    const f = await fixture({ initialProviderUsage: usage }, false);
    await worker.failTurn(f.claimed.turn, f.claimed.leaseToken, interrupted);
    const closed = await ChatTurn.findById(f.turn._id);
    assert.equal(closed.status, 'failed'); assert.equal(closed.reconciliation.source, SOURCE);
    assert.deepEqual(closed.usage.toObject(), usage); assert.equal(closed.reconciliation.userChargeTokens, 400);
    assert.equal(closed.needsReconciliation, false); assert.equal(closed.reconciliation.platformCoversUnknown, false);
    const g = await fixture({ leaseUntil: new Date(0), responseState: { pending: true, calls: 1,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } }, false);
    await Promise.all([worker.recoverExpired(), worker.recoverExpired()]);
    const recovered = await ChatTurn.findById(g.turn._id);
    assert.equal(recovered.reservationState, 'released'); assert.equal(recovered.reconciliation.providerUsageKnown, false);
    assert.equal(recovered.error.retryable, false); assert.equal(recovered.needsReconciliation, false);
    assert.equal((await User.findById(g.user._id)).reservedAppTokens, 0);
    assert.equal(await TokenOperation.countDocuments({ 'context.turnId': g.turn.turnId, kind: 'reservation_release' }), 1);
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: g.turn.turnId }), 0);
  });

  test('overlapping computation and Responses aggregates are counted once, including a crash between their writes', () => {
    const state = (pending, u) => ({ pending, usage: u });
    assert.deepEqual(confirmedUsage({ computeState: state(false, usage), responseState: state(false, usage) }),
      { usage, usageSource: 'responseState', providerUsageKnown: true, platformCoversUnknown: false });
    const split = confirmedUsage({ computeState: state(false, usage), responseState: state(true, first) });
    assert.deepEqual(split.usage, usage); assert.equal(split.platformCoversUnknown, false);
    const pending = confirmedUsage({ computeState: state(true, usage), responseState: state(true, usage) });
    assert.deepEqual(pending.usage, usage); assert.equal(pending.providerUsageKnown, false);
    assert.throws(() => confirmedUsage({ computeState: state(false, first), responseState: state(true, usage) }), /CONFLICTING_USAGE/);
    assert.throws(() => confirmedUsage({ browserState: state(false, usage), responseState: state(true, usage) }), /CONFLICTING_WORKFLOWS/);
  });

  test('stale plans, the wrong attempt or hold, damaged receipts and existing charges cannot release or debit', async () => {
    const f = await fixture({ initialProviderUsage: first });
    const p = await run(f.target);
    await assert.rejects(run({ ...f.target, heldTokens: held - 1 }), /TARGET_OR_AMOUNT_MISMATCH/);
    await assert.rejects(run({ ...f.target, attempt: 2 }), /TARGET_OR_AMOUNT_MISMATCH/);
    await assert.rejects(run(f.target, { ...p, entry: { ...p.entry, userChargeTokens: 0 } }), /STALE_PLAN/);
    await ChatTurn.updateOne({ _id: f.turn._id }, { $set: { initialProviderUsage: usage } });
    await assert.rejects(run(f.target, p), /STALE_PLAN/);
    const filter = { 'context.turnId': f.turn.turnId, key: { $regex: '^reservation_hold:web:' } };
    await TokenOperation.deleteOne(filter);
    await assert.rejects(run(f.target), /HOLD_RECEIPTS_MISMATCH/);
    await ChatBillingLedger.create({ turnId: f.turn.turnId, user: f.user._id, modelId: f.turn.modelId,
      appTokensSpent: 10, totalTokens: 10, usd: 1, balance: 99990 });
    await assert.rejects(run(f.target), /EXISTING_CHARGE_OR_RELEASE/);
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, held);
    assert.equal(await TokenOperation.countDocuments({ 'context.turnId': f.turn.turnId, kind: 'reservation_release' }), 0);
  });

  test('active turns, document jobs, inconsistent usage and unattributed account reserves require review', async () => {
    const f = await fixture({}, false);
    await assert.rejects(run(f.target), /INELIGIBLE_ATTEMPT/);
    const g = await fixture({ initialProviderUsage: { ...usage, totalTokens: 1 } });
    await assert.rejects(run(g.target), /INVALID_INITIAL_USAGE/);
    await ChatTurn.updateOne({ _id: g.turn._id }, { $set: { initialProviderUsage: null } });
    await DocumentJob.collection.insertOne({ turnId: g.turn.turnId, attempt: 1, status: 'running' });
    await assert.rejects(run(g.target), /DOCUMENT_JOB_OWNS_TURN/);
    await DocumentJob.deleteOne({ turnId: g.turn.turnId });
    await User.updateOne({ _id: g.user._id }, { $inc: { reservedAppTokens: 7 } });
    await assert.rejects(run(g.target), /ACCOUNT_HOLDS_MISMATCH/);
    assert.equal((await User.findById(g.user._id)).reservedAppTokens, held + 7);
  });

  test('failed balance notification rolls back billing, receipt and release together, then retry succeeds', async t => {
    const f = await fixture({ initialProviderUsage: usage });
    const p = await run(f.target);
    const original = BalanceOutbox.create.bind(BalanceOutbox);
    const mock = t.mock.method(BalanceOutbox, 'create', (rows, ...args) => {
      if (rows.some(row => row.reason === 'reservation_release')) throw new Error('Outbox unavailable');
      return original(rows, ...args);
    });
    await assert.rejects(run(f.target, p), /Outbox unavailable/);
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, held);
    assert.equal((await User.findById(f.user._id)).appTokens, 100000);
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: f.turn.turnId }), 0);
    assert.equal((await ChatTurn.findById(f.turn._id)).reconciliation, null);
    mock.mock.restore();
    assert.equal((await run(f.target, p)).chargedThisRun, 400);
  });

  test('a retry after manual no-charge reconciliation retains its old receipt and can settle the new attempt', async () => {
    const f = await fixture();
    await require('../../src/services/chatDeliveryV2/reconcileReservation')({ turnId: f.turn.turnId, attempt: 1,
      noCharge: true, reason: 'provider confirmed no cost' });
    const queued = await retry({ turnId: f.turn.turnId, userId: f.user._id });
    assert.equal(queued.attempt, 2); assert.equal(queued.reconciliation, null);
    const archived = await ChatTurn.findById(f.turn._id).select('+reconciliationHistory');
    assert.equal(archived.reconciliationHistory[0].attempt, 1);
    assert.equal(archived.reconciliationHistory[0].receipt.noCharge, true);
    const next = { turnId: f.turn.turnId, attempt: 2, heldTokens: queued.reservedAppTokens };
    await ChatTurn.updateOne({ _id: f.turn._id }, { $set: { status: 'failed', needsReconciliation: true, providerStartedAt: new Date() } });
    assert.equal((await run(next, await run(next))).releasedThisRun, queued.reservedAppTokens);
  });
}
