const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const uri = process.env.CHAT_V2_TEST_MONGO_URI;
if (!uri) {
  test('stopped document repair requires a disposable replica set', { skip: true }, () => {});
} else {
  const { User, ChatTurn, ChatConversation, ChatBillingLedger, TokenOperation, BalanceOutbox } = require('../../src/models');
  const Job = require('../../src/models/documentJob'), Chunk = require('../../src/models/documentJobChunk');
  const repair = require('../../src/services/chatDeliveryV2/reconcileStoppedDocuments');
  const ledger = require('../../src/services/tokenLedger');
  const snapshots = async user => ({ user: await User.findById(user).lean(), turns: await ChatTurn.find({ user }).sort({ turnId: 1 }).lean(),
    ops: await TokenOperation.find({ 'entries.user': user }).sort({ key: 1 }).lean(),
    bills: await ChatBillingLedger.find({ user }).lean(), outbox: await BalanceOutbox.find({ user }).lean() });
  test.before(async () => {
    await mongoose.connect(uri, { dbName: `gpt_titi_test_stopped_${crypto.randomBytes(4).toString('hex')}` });
    for (const m of [User, ChatTurn, ChatConversation, ChatBillingLedger, TokenOperation, BalanceOutbox, Job, Chunk]) await m.createIndexes();
  });
  test.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  async function transaction(action) {
    const session = await mongoose.startSession();
    try { return await session.withTransaction(() => action(session)); }
    finally { await session.endSession(); }
  }
  async function fixture(holds = [21798, 20348, 20058, 14656], apiMode = 'chat_completions') {
    const user = await User.create({ email: crypto.randomUUID() + '@example.test', appTokens: 8830660, status: 'active' });
    const conv = await ChatConversation.create({ user: user._id, modelId: 'disabled-test-model', title: 'Repair test' });
    const turns = [];
    for (const held of holds) {
      const turnId = crypto.randomUUID(), jobId = new mongoose.Types.ObjectId();
      const usage = { promptTokens: 10000, completionTokens: 1000, totalTokens: 11000 };
      const turn = await ChatTurn.create({ turnId, user: user._id, conversation: conv._id, clientMessageId: crypto.randomUUID(),
        requestHash: 'hash', modelId: 'disabled-test-model', message: 'private prompt', userMessage: new mongoose.Types.ObjectId(),
        status: 'failed', attempt: 1, reservedAppTokens: held, reservationState: 'held', needsReconciliation: true,
        providerStartedAt: new Date(), providerConfig: { apiMode }, error: { code: 'PROCESS_INTERRUPTED', message: 'Interrupted', retryable: false },
        pricing: { inputPerM: 0.1, outputPerM: 0.2, tokenValueUsd: 0.00001 },
        computeState: { kind: 'document', stage: 'executing', pending: false, usage, documentJob: { id: String(jobId), active: true } },
        ...(apiMode === 'responses' ? { responseState: { pending: false, usage } } : {}),
      });
      await Job.create({ _id: jobId, user: user._id, turn: turn._id, turnId, attempt: 1, adapter: 'xlsx-v1',
        sourceFile: new mongoose.Types.ObjectId(), sourceChecksum: 'a'.repeat(64), plan: {}, selection: {},
        status: 'cancelled', errorCode: 'DOCUMENT_TURN_GONE', finishedAt: new Date(), deadline: new Date(Date.now() + 86400000), total: 10000 });
      // Admission plus a continuation hold, as in the affected production rows.
      await transaction(async session => {
        await ledger.changeReservation({ userId: user._id, amount: held - 100, turnId, attempt: 1, session });
        await ledger.increaseComputationReservation({ userId: user._id, amount: 100, turnId, attempt: 1, phase: 1, session });
      });
      turns.push(turn);
    }
    return { user, turns, targets: turns.map(t => ({ turnId: t.turnId, attempt: 1 })) };
  }

  test('dry run explains exactly 76860 held TITI without changing any ledger or turn', async () => {
    const f = await fixture(), before = await snapshots(f.user._id);
    const p = await repair.plan(f.targets);
    assert.equal(p.readOnly, true); assert.equal(p.entries.length, 4);
    assert.equal(p.totals.releaseTokens, 76860); assert.equal(p.totals.chargeTokens, 480);
    assert.equal(p.projectedBalance.appTokens, 8830180); assert.equal(p.projectedBalance.reservedAppTokens, 0);
    assert.deepEqual(await snapshots(f.user._id), before);
    assert.doesNotMatch(JSON.stringify(p), /private prompt|example.test/);
  });
  for (const api of ['chat_completions', 'responses']) test(`${api}: atomic settlement preserves another active hold and publishes balances`, async () => {
    const f = await fixture(undefined, api);
    await transaction(session => ledger.changeReservation({ userId: f.user._id, amount: 777, turnId: crypto.randomUUID(), attempt: 1, session }));
    const plan = await repair.plan(f.targets), result = await repair.apply(plan);
    assert.equal(result.releasedTokens, 76860); assert.equal(result.chargedTokens, 480);
    assert.equal(result.balanceAfter.reservedAppTokens, 777);
    assert.equal(result.balanceAfter.availableTokens, 8830180 - 777);
    for (const turn of f.turns) {
      const done = await ChatTurn.findById(turn._id).lean();
      assert.equal(done.status, 'failed'); assert.equal(done.needsReconciliation, false);
      assert.equal(done.reservationState, 'settled'); assert.equal(done.computeState.documentJob.active, false);
      assert.equal(done.error.retryable, false); assert.equal(done.billing.appTokensSpent, 120);
      assert.equal(await ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 1);
      assert.equal(await TokenOperation.countDocuments({ 'context.turnId': turn.turnId, kind: 'reservation_release' }), 1);
    }
    const events = [], outbox = require('../../src/services/balanceOutbox').createOutboxWorker({ bus: { publish: async e => events.push(e) } });
    await outbox.drain(); await outbox.stop();
    const last = events.filter(e => e.userId === String(f.user._id)).at(-1);
    assert.equal(last.reservedAppTokens, 777); assert.equal(last.appTokens, 8830180);
  });
  test('concurrent and repeated application cannot charge or release twice', async () => {
    const f = await fixture([21798]), p = await repair.plan(f.targets);
    const rs = await Promise.all([repair.apply(p), repair.apply(p)]);
    assert.equal(rs.reduce((n, r) => n + r.chargedTokens, 0), 120);
    assert.equal(rs.reduce((n, r) => n + r.releasedTokens, 0), 21798);
    const before = await snapshots(f.user._id), again = await repair.apply(p);
    assert.equal(again.entries[0].alreadyApplied, true); assert.deepEqual(await snapshots(f.user._id), before);
  });
  test('invalid second entry rolls back earlier charges and releases in the batch', async () => {
    const f = await fixture([21798, 20348]), p = await repair.plan(f.targets), before = await snapshots(f.user._id);
    p.entries[1].chargeTokens++;
    await assert.rejects(repair.apply(p), { code: 'REPAIR_PLAN_STALE' });
    assert.deepEqual(await snapshots(f.user._id), before);
  });
  test('failed release notification rolls back charge, release and reconciliation', async t => {
    const f = await fixture([21798]), p = await repair.plan(f.targets), before = await snapshots(f.user._id);
    const original = BalanceOutbox.create.bind(BalanceOutbox);
    t.mock.method(BalanceOutbox, 'create', (items, ...rest) => {
      if (items.some(i => i.reason === 'reservation_release')) throw new Error('Simulated outbox outage');
      return original(items, ...rest);
    });
    await assert.rejects(repair.apply(p), /Simulated outbox outage/);
    assert.deepEqual(await snapshots(f.user._id), before);
  });
  const unsafe = [
    ['pending provider call', { 'computeState.pending': true }],
    ['ambiguous Responses call', { responseState: { pending: true } }],
    ['different Responses usage', { responseState: { pending: false, usage: { promptTokens: 11000, completionTokens: 1000, totalTokens: 12000 } } }],
    ['missing usage', { 'computeState.usage': null }],
    ['inconsistent usage totals', { 'computeState.usage.totalTokens': 12 }],
    ['missing saved price', { pricing: null }],
    ['processing turn', { status: 'processing' }],
    ['saved provider result', { providerResult: { assistantText: 'done' } }],
  ];
  for (const [name, change] of unsafe) test(`refuses ${name} without account changes`, async () => {
    const f = await fixture([21798]); await ChatTurn.updateOne({ _id: f.turns[0]._id }, { $set: change });
    const before = await snapshots(f.user._id);
    await assert.rejects(repair.plan(f.targets), /REPAIR_/); assert.deepEqual(await snapshots(f.user._id), before);
  });
  test('refuses a running job and a missing terminal job', async () => {
    const f = await fixture([21798]); await Job.updateOne({ turnId: f.turns[0].turnId }, { $set: { status: 'running' } });
    await assert.rejects(repair.plan(f.targets), { code: 'REPAIR_UNSAFE_JOB' });
    await Job.deleteOne({ turnId: f.turns[0].turnId });
    await assert.rejects(repair.plan(f.targets), { code: 'REPAIR_UNSAFE_JOB' });
  });
  test('application rechecks job state after preview and keeps the reserve on a race', async () => {
    const f = await fixture([21798]), p = await repair.plan(f.targets);
    await Job.updateOne({ turnId: f.turns[0].turnId }, { $set: { status: 'queued' } });
    const before = await snapshots(f.user._id);
    await assert.rejects(repair.apply(p), { code: 'REPAIR_UNSAFE_JOB' });
    assert.deepEqual(await snapshots(f.user._id), before);
  });
  test('explicit targets cannot be empty, duplicate or unbounded', async () => {
    const f = await fixture([21798]);
    for (const ts of [[], [f.targets[0], f.targets[0]], Array(21).fill(f.targets[0]), [{ turnId: { $ne: null }, attempt: 1 }]]) {
      await assert.rejects(repair.plan(ts), { code: 'REPAIR_INVALID_TARGETS' });
    }
  });
  test('refuses orphan staging chunks even with zero job counters', async () => {
    const f = await fixture([21798]), job = await Job.findOne({ turnId: f.turns[0].turnId });
    await Chunk.collection.insertOne({ job: job._id, index: 0 });
    await assert.rejects(repair.plan(f.targets), { code: 'REPAIR_UNSAFE_JOB' });
  });
  test('refuses a missing hold receipt or an already charged attempt', async () => {
    const f = await fixture([21798]); await TokenOperation.deleteOne({ 'context.turnId': f.turns[0].turnId });
    await assert.rejects(repair.plan(f.targets), { code: 'REPAIR_RESERVATION_MISMATCH' });
    await ChatBillingLedger.create({ turnId: f.turns[0].turnId, user: f.user._id, modelId: 'old', appTokensSpent: 120, totalTokens: 11000, usd: .0012, balance: 8830540 });
    await assert.rejects(repair.plan(f.targets), { code: 'REPAIR_EXISTING_CHARGE' });
  });
  test('rejects stale plan after usage or price changes, and another account', async () => {
    const f = await fixture([21798]), p = await repair.plan(f.targets);
    await ChatTurn.updateOne({ _id: f.turns[0]._id }, { $set: { 'pricing.inputPerM': .2 } });
    await assert.rejects(repair.apply(p), { code: 'REPAIR_PLAN_STALE' });
    p.userId = String(new mongoose.Types.ObjectId());
    await assert.rejects(repair.apply(p), { code: 'REPAIR_ACCOUNT_MISMATCH' });
    const other = await fixture([20058]);
    await assert.rejects(repair.plan([...f.targets, ...other.targets]), { code: 'REPAIR_MIXED_ACCOUNTS' });
  });
  test('CLI plan is valid JSON, read only, and requires explicit targets and database', async () => {
    const f = await fixture([21798]), before = await snapshots(f.user._id);
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-reserves-'));
    try {
      const file = path.join(dir, 'targets.json'); fs.writeFileSync(file, JSON.stringify({ turns: f.targets }));
      const parsed = new URL(uri); parsed.pathname = '/' + mongoose.connection.name;
      const output = execFileSync(process.execPath, ['scripts/reconcileStoppedDocumentReservations.js', '--plan', file],
        { cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 20000,
          env: { ...process.env, CHAT_RECONCILIATION_MONGO_URI: parsed.toString() } });
      assert.equal(JSON.parse(output).totals.releaseTokens, 21798);
      assert.deepEqual(await snapshots(f.user._id), before);
      assert.doesNotMatch(output, /mongodb:|private prompt|example.test/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
