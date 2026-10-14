require("dotenv").config();

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const uri = process.env.CHAT_V2_TEST_MONGO_URI;
if (!uri) {
  test("reservation transactions require a test replica set", { skip: true }, () => {});
} else {
  process.env.OPENAI_API_KEY ||= "test-placeholder";
  const { User, ChatTurn, ChatModels, ChatMessage, ChatConversation, ChatBillingLedger, TokenOperation, BalanceOutbox } = require("../../src/models");
  const acceptTurn = require("../../src/services/chatDeliveryV2/acceptTurn");
  const retryTurn = require("../../src/services/chatDeliveryV2/retryTurn");
  const worker = require("../../src/services/chatDeliveryV2/worker");
  const ledger = require("../../src/services/tokenLedger");
  const reconcile = require("../../src/services/chatDeliveryV2/reconcileReservation");
  const { errorFor } = require("../../src/services/chatDeliveryV2/protocol");
  const make = async (balance = 100) => {
    const id = crypto.randomUUID();
    const user = await User.create({ email: `${id}@example.test`, appTokens: balance });
    const model = await ChatModels.create({ modelId: id, label: "Test", category: "chat", enabled: true, inputPerM: 10, outputPerM: 10 });
    const conversation = await ChatConversation.create({ user: user._id, title: "Test", modelId: id });
    const payload = { clientMessageId: crypto.randomUUID(), conversationId: String(conversation._id), modelId: id, message: "hello" };
    return { user, model, conversation, payload, send: (p = payload) => acceptTurn({ userId: user._id, payload: p }) };
  };
  test.before(async () => {
    await mongoose.connect(uri, { dbName: `gpt_titi_test_res_${crypto.randomBytes(4).toString("hex")}` });
    for (const model of [User, ChatTurn, ChatModels, ChatMessage, ChatConversation, ChatBillingLedger, TokenOperation, BalanceOutbox]) await model.createIndexes();
  });
  test.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  test("concurrent duplicate submissions reserve once, even when nothing remains", async () => {
    const f = await make(2);
    const results = await Promise.all(Array.from({ length: 12 }, () => f.send()));
    assert.equal(new Set(results.map((r) => r.turn.turnId)).size, 1);
    const user = await User.findById(f.user._id).lean();
    assert.equal(user.reservedAppTokens, results[0].turn.reservedAppTokens);
    assert.equal(user.appTokens, 2);
    assert.equal(await ChatTurn.countDocuments({ user: f.user._id }), 1);
  });

  test("two different requests cannot reserve the same remaining balance", async () => {
    const f = await make(2);
    const results = await Promise.allSettled([f.send(), f.send({ ...f.payload, clientMessageId: crypto.randomUUID() })]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const error = results.find((r) => r.status === "rejected").reason.protocolError;
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
    assert.equal(error.details.availableTokens, 0);
    assert.equal(error.details.estimatedTokens, 2);
  });

  test("transfers cannot spend a hold; completion can overdraw and duplicate delivery remains safe", async () => {
    const f = await make(2); const recipient = await make();
    const accepted = await f.send();
    await assert.rejects(ledger.transfer({ senderId: f.user._id, recipientId: recipient.user._id, amount: 1, key: crypto.randomUUID() }), { code: "INSUFFICIENT_BALANCE" });
    const claimed = await worker.claimTurn(accepted.turn.turnId);
    const usage = { promptTokens: 100, completionTokens: 1200, totalTokens: 1300 };
    const result = await worker.commitCompletion(claimed.turn, claimed.leaseToken, "Answer", usage);
    assert.equal(result.billing.balance, -1298);
    const user = await User.findById(f.user._id).lean();
    assert.equal(user.reservedAppTokens, 0);
    assert.equal((await f.send()).disposition, "duplicate");
    await assert.rejects(f.send({ ...f.payload, clientMessageId: crypto.randomUUID() }), (e) => e.protocolError.code === "BALANCE_LIMIT_EXCEEDED" && e.protocolError.details.balance === -1298);
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: accepted.turn.turnId }), 1);
    assert.equal(await TokenOperation.countDocuments({ key: `chat:${accepted.turn.turnId}` }), 1);
    await assert.rejects(worker.commitCompletion(claimed.turn, claimed.leaseToken, "Answer", usage), (e) => e.staleLease === true);
    await ledger.credit({ userId: f.user._id, amount: 1400, kind: "top_up", key: crypto.randomUUID() });
    await f.send({ ...f.payload, clientMessageId: crypto.randomUUID() });
  });

  test("strict negative threshold and all-model reservation admission", async () => {
    for (const [balance, code] of [[-1001, "BALANCE_LIMIT_EXCEEDED"], [-1000, "INSUFFICIENT_BALANCE"], [-1, "INSUFFICIENT_BALANCE"], [0, "INSUFFICIENT_BALANCE"]]) {
      const f = await make(balance);
      await assert.rejects(f.send(), (e) => e.protocolError.code === code);
      assert.equal(await ChatMessage.countDocuments({ user: f.user._id }), 0);
    }
  });

  test("failure before provider releases once; retry atomically acquires a new hold", async () => {
    const f = await make(); const accepted = await f.send(); const claimed = await worker.claimTurn(accepted.turn.turnId);
    await worker.failTurn(claimed.turn, claimed.leaseToken, errorFor("PROVIDER_UNAVAILABLE"));
    await worker.failTurn(claimed.turn, claimed.leaseToken, errorFor("PROVIDER_UNAVAILABLE"));
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, 0);
    const retried = await retryTurn({ turnId: accepted.turn.turnId, userId: f.user._id });
    assert.equal(retried.attempt, 2); assert.equal(retried.reservationState, "held");
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, 2);
  });

  test("expired uncertain provider call retains hold and requires explicit reconciliation", async () => {
    const f = await make(); const accepted = await f.send(); const claimed = await worker.claimTurn(accepted.turn.turnId);
    await ChatTurn.updateOne({ _id: claimed.turn._id }, { $set: { providerStartedAt: new Date(), leaseUntil: new Date(0) } });
    await worker.recoverExpired();
    const turn = await ChatTurn.findById(claimed.turn._id);
    assert.equal(turn.needsReconciliation, true); assert.equal(turn.error.retryable, false);
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, 2);
    await assert.rejects(retryTurn({ turnId: turn.turnId, userId: f.user._id }), (e) => e.protocolError.code === "TURN_NOT_RETRYABLE");
    await reconcile({ turnId: turn.turnId, attempt: 1, noCharge: true, reason: "Provider confirmed no usage" });
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, 0);
    await assert.rejects(reconcile({ turnId: turn.turnId, attempt: 1, noCharge: true, reason: "Duplicate" }));
    await retryTurn({ turnId: turn.turnId, userId: f.user._id });
  });

  test("persisted provider result is recovered once without another generation", async () => {
    const f = await make(); const accepted = await f.send(); const claimed = await worker.claimTurn(accepted.turn.turnId);
    await ChatTurn.updateOne({ _id: claimed.turn._id }, { $set: { leaseUntil: new Date(0), providerStartedAt: new Date(),
      providerResult: { assistantText: "Durable answer", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } } } });
    await Promise.all([worker.recoverExpired(), worker.recoverExpired()]);
    const turn = await ChatTurn.findById(claimed.turn._id);
    assert.equal(turn.status, "completed"); assert.equal(turn.reservationState, "settled");
    assert.equal((await User.findById(f.user._id)).appTokens, 70);
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, 0);
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 1);
  });

  test("parallel accepted charges preserve other holds and bill their full cost", async () => {
    const f = await make(10);
    const first = await f.send(); const second = await f.send({ ...f.payload, clientMessageId: crypto.randomUUID() });
    const a = await worker.claimTurn(first.turn.turnId); const b = await worker.claimTurn(second.turn.turnId);
    await worker.commitCompletion(a.turn, a.leaseToken, "A", { promptTokens: 20, completionTokens: 0, totalTokens: 20 });
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, 2);
    await worker.commitCompletion(b.turn, b.leaseToken, "B", { promptTokens: 5, completionTokens: 0, totalTokens: 5 });
    const user = await User.findById(f.user._id);
    assert.equal(user.appTokens, -15); assert.equal(user.reservedAppTokens, 0);
  });

  test("failed transaction rolls back both reservation and message creation", async (t) => {
    const f = await make();
    t.mock.method(ChatMessage, "create", async () => { throw new Error("Simulated failure"); });
    await assert.rejects(f.send(), /Simulated failure/);
    assert.equal((await User.findById(f.user._id)).reservedAppTokens, 0);
    assert.equal(await ChatTurn.countDocuments({ user: f.user._id }), 0);
  });
  test("holds and release publish versioned live snapshots without a fake spend", async () => {
    const f = await make(100);
    const accepted = await f.send();
    const held = await ledger.getBalance(f.user._id);
    assert.equal(held.appTokens, 100);
    assert.equal(held.reservedAppTokens, 2);
    assert.equal(held.availableTokens, 98);
    assert.equal(held.maxTransferTokens, 98);
    assert.equal(held.balanceVersion, 1);
    const events = [];
    const outbox = require("../../src/services/balanceOutbox").createOutboxWorker({
      bus: { publish: async (event) => events.push(event) },
    });
    await outbox.drain();
    const holdEvent = events.find((e) => e.userId === String(f.user._id));
    assert.equal(holdEvent.reservedAppTokens, 2);
    assert.equal(holdEvent.reason, "reservation_hold");
    assert.equal(holdEvent.balanceVersion, 1);
    const claimed = await worker.claimTurn(accepted.turn.turnId);
    await worker.failTurn(claimed.turn, claimed.leaseToken, errorFor("PROVIDER_UNAVAILABLE"));
    await outbox.drain();
    const released = events.filter((e) => e.userId === String(f.user._id)).at(-1);
    assert.equal(released.balanceVersion, 2);
    assert.equal(released.reservedAppTokens, 0);
    assert.equal(released.maxTransferTokens, 100);
    assert.equal(released.appTokens, 100);
    assert.equal(released.reason, "reservation_release");
    await outbox.stop();
  });

  test("reservation notification failure rolls back the hold and turn", async (t) => {
    const f = await make();
    t.mock.method(BalanceOutbox, "create", async () => { throw new Error("Outbox unavailable"); });
    await assert.rejects(f.send(), /Outbox unavailable/);
    const user = await User.findById(f.user._id);
    assert.equal(user.reservedAppTokens, 0);
    assert.equal(user.balanceVersion, 0);
    assert.equal(await ChatTurn.countDocuments({ user: f.user._id }), 0);
    assert.equal(await TokenOperation.countDocuments({ "entries.user": f.user._id }), 0);
  });

}
