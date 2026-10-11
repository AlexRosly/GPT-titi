const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const mongoose = require("mongoose");
const { User, TokenOperation, TokenTransfer, Payment, ChatConversation, ChatMessage, ChatModels, ChatBillingLedger, ChatTurn } = require("../src/models");
const ledger = require("../src/services/tokenLedger");
const history = require("../src/services/tokenHistory");
const finalizeCharge = require("../src/services/finalizeCharge");
const { APP_TOKEN_VALUE_USD } = require("../src/config/billing");
const uri = process.env.TOKEN_HISTORY_TEST_MONGO_URI;

test("real token history and billing integration", { skip: !uri, timeout: 60000 }, async (t) => {
  const dbName = `token_history_test_${process.pid}_${randomUUID().slice(0, 8)}`;
  await mongoose.connect(uri, { dbName });
  t.after(async () => {
    assert.equal(mongoose.connection.db.databaseName, dbName);
    assert.match(dbName, /^token_history_test_\d+_[0-9a-f-]+$/);
    await mongoose.connection.db.dropDatabase(); await mongoose.disconnect();
  });
  await Promise.all(Object.values(require("../src/models")).map((model) => model.createIndexes()));
  const account = () => User.create({ email: `${randomUUID()}@example.test`, appTokens: 20000 });
  const [user, recipient, outsider] = await Promise.all([account(), account(), account()]);
  const zone = "Europe/Kyiv";
  const yesterday = "2026-10-10T20:00:00.000Z";
  const today = "2026-10-10T21:30:00.000Z";
  const at = async (result, date) => {
    await TokenOperation.collection.updateOne({ _id: new mongoose.Types.ObjectId(result.operation.id) }, { $set: { createdAt: new Date(date) } });
    return result;
  };
  const payment = await Payment.create({ user: user._id, stripeSessionId: "cs_history", amount: 199, currency: "eur", appTokensAdded: 1000 });
  await at(await ledger.credit({ userId: user._id, amount: 1000, kind: "topup", key: "stripe:checkout:cs_history",
    context: { paymentId: payment._id, paymentAmountMinor: 199, paymentCurrency: "eur" } }), today);
  const transfer = await at(await ledger.transfer({ senderId: user._id, recipientId: recipient._id, amount: 30, key: "transfer:test" }), today);
  await TokenTransfer.create({ sender: user._id, recipient: recipient._id, recipientEmail: recipient.email, clientTransferId: randomUUID(), amount: 30, senderBalance: transfer.sender.appTokens, operation: transfer.operation.id });
  await at(await ledger.claimBonus({ userId: user._id }), yesterday);
  const conversation = await ChatConversation.create({ user: user._id, title: "Actual billed chat" });
  await ChatModels.create({ modelId: "history-model", enabled: true, inputPerM: APP_TOKEN_VALUE_USD * 1e6, outputPerM: APP_TOKEN_VALUE_USD * 1e6 });
  for (let i = 0; i < 32; i++) {
    await at(await ledger.debit({ userId: user._id, amount: 10, kind: "chat_charge", key: `history:${i}`,
      context: { modelId: i % 2 ? "model-b" : "model-a", conversationId: conversation._id, conversationTitle: conversation.title, totalTokens: 100, costUsd: 0.01 } }), i < 16 ? today : yesterday);
  }
  await at(await ledger.refund({ userId: user._id, amount: 100, key: "refund:history", context: { paymentId: payment._id, paymentAmountMinor: 199, paymentCurrency: "eur" } }), today);
  // A copied chat advertises the original cost but never changes ledger history.
  await ChatMessage.create({ user: user._id, conversation: conversation._id, role: "assistant", content: "Forked answer", modelId: "model-a", tokens: 99999, meta: { appTokens: 99999 } });
  await ledger.credit({ userId: outsider._id, amount: 987654, kind: "topup" });

  await t.test("General preserves non-usage and aggregates both local days", async () => {
    const result = await history.getHistory(user._id, { timeZone: zone });
    assert.equal(result.days.length, 2);
    assert.deepEqual(result.days.map((d) => d.day), ["2026-10-11", "2026-10-10"]);
    assert.equal(result.days[0].usage.chargeCount, 16);
    assert.equal(result.days[0].usage.amount, -160);
    assert.equal(result.days[0].usage.modelCount, 2);
    const purchase = result.days[0].activity.find((a) => a.type === "purchase");
    assert.equal(purchase.payment.amountMinor, 199); assert.equal(purchase.payment.currency, "eur");
    assert.equal(result.days[0].activity.filter((a) => a.type === "purchase").length, 1);
    assert(result.days[0].activity.some((a) => a.type === "refund"));
    const sent = result.days[0].activity.find((a) => a.type === "sent");
    assert.equal(sent.peer, recipient.email);
    const received = await history.getHistory(recipient._id, { mode: "detailed", timeZone: zone });
    assert.equal(received.items[0].type, "received"); assert.equal(received.items[0].peer, user.email);
    assert.equal(received.items[0].balanceAfter, transfer.recipient.appTokens);
    assert(!JSON.stringify(received).includes('senderBalance'));
    const summary = await history.getSummary(user._id, { timeZone: zone, from: "2026-10-11", to: "2026-10-11", type: "usage", limit: "1" });
    assert.equal(summary.incoming, 1000); assert.equal(summary.outgoing, -290); assert.equal(summary.netChange, 710);
    assert.equal(summary.coverage.includesPreLedgerHistory, false);
  });
  await t.test("day details use real combined costs with stable pagination and no copies", async () => {
    const query = { timeZone: zone, limit: "5" };
    const ids = [];
    do {
      const result = await history.getDayCharges(user._id, "2026-10-11", query);
      ids.push(...result.items.map((item) => item.id));
      assert(result.items.every((item) => item.amount === -10 && item.conversationId === String(conversation._id)));
      query.cursor = result.nextCursor || undefined;
    } while (query.cursor);
    assert.equal(ids.length, 16); assert.equal(new Set(ids).size, 16);
    const usage = await history.getUsageSummary(user._id, { timeZone: zone });
    assert.equal(usage.byModel.reduce((s, item) => s + item.appTokens, 0), 320);
    assert.equal(usage.totalTokens, 3200);
    const first = await history.getHistory(user._id, { timeZone: zone, limit: "1" });
    const second = await history.getHistory(user._id, { timeZone: zone, limit: "1", cursor: first.nextCursor });
    assert.equal(second.days[0].day, "2026-10-10"); assert.equal(second.nextCursor, null);
    await assert.rejects(history.getHistory(outsider._id, { timeZone: zone, limit: "1", cursor: first.nextCursor }), { code: "INVALID_HISTORY_QUERY" });
  });
  await t.test("legacy finalization journals context once and rolls back if message billing fails", async (subtest) => {
    const msg = await ChatMessage.create({ user: user._id, conversation: conversation._id, role: "assistant", content: "Bill me" });
    const options = { userId: user._id, modelId: "history-model", conversationId: conversation._id, messageId: msg._id,
      usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 } };
    const before = await ledger.getBalance(user._id);
    await finalizeCharge(options); await finalizeCharge(options);
    assert.equal((await ledger.getBalance(user._id)).appTokens, before.appTokens - 100);
    const operation = await TokenOperation.findOne({ key: `chat-message:${msg._id}` }).lean();
    assert.equal(operation.context.modelId, "history-model"); assert.equal(operation.context.conversationTitle, conversation.title);
    assert.equal(operation.context.totalTokens, 100);
    assert.equal((await ChatMessage.findById(msg._id)).meta.appTokens, 100);
    const another = await ChatMessage.create({ user: user._id, conversation: conversation._id, role: "assistant", content: "Rollback" });
    const current = await ledger.getBalance(user._id);
    const stub = subtest.mock.method(ChatMessage, "updateOne", async () => { throw new Error("message write failed"); });
    await assert.rejects(finalizeCharge({ ...options, messageId: another._id }), /message write failed/); stub.mock.restore();
    assert.equal((await ledger.getBalance(user._id)).appTokens, current.appTokens);
    assert.equal(await TokenOperation.countDocuments({ key: `chat-message:${another._id}` }), 0);
  });
  await t.test("old v2 and Stripe ledger context is recovered without duplicate operations", async () => {
    const oldUser = await account();
    const msg = await ChatMessage.create({ user: oldUser._id, conversation: conversation._id, role: "user", content: "old" });
    await ChatTurn.create({ user: oldUser._id, conversation: conversation._id, turnId: "old-v2", modelId: "old-model", clientMessageId: "old-client", requestHash: "hash", message: "old", userMessage: msg._id });
    await ChatBillingLedger.create({ user: oldUser._id, turnId: "old-v2", modelId: "old-model", appTokensSpent: 12, totalTokens: 42, usd: 0.01, balance: 19988 });
    await ledger.debit({ userId: oldUser._id, amount: 12, kind: "chat_charge", key: "chat:old-v2" });
    await Payment.create({ user: oldUser._id, stripeSessionId: "cs_old", amount: 250, currency: "usd", appTokensAdded: 300 });
    await ledger.credit({ userId: oldUser._id, amount: 300, kind: "topup", key: "stripe:checkout:cs_old" });
    await ledger.debit({ userId: oldUser._id, amount: 7, kind: "chat_charge", key: "chat_charge:unlinked" });
    const result = await history.getHistory(oldUser._id, { mode: "detailed" });
    assert.equal(result.items.length, 3);
    assert.equal(result.items.find((a) => a.model === "old-model").amount, -12);
    assert.equal(result.items.find((a) => a.type === "purchase").payment.amountMinor, 250);
    const unknown = result.items.find((a) => a.amount === -7); assert.equal(unknown.model, null); assert.equal(unknown.detailsAvailable, false);
    assert.equal((await history.getUsageSummary(oldUser._id)).byModel.reduce((s, r) => s + r.appTokens, 0), 19);
  });
  await t.test("large nonusage day has an explicit continuation, not hidden truncation", async () => {
    const busy = await account();
    const entries = Array.from({ length: 105 }, (_, i) => ({ key: `busy:${i}`, kind: "bonus", status: "confirmed",
      entries: [{ user: busy._id, delta: 1, balance: i, balanceVersion: i + 1 }], createdAt: new Date(today) }));
    await TokenOperation.insertMany(entries);
    const result = await history.getHistory(busy._id, { timeZone: zone });
    assert.equal(result.days[0].activity.length, 100); assert.equal(result.days[0].operationCount, 105);
    const more = await history.getHistory(busy._id, { ...result.days[0].activityQuery, cursor: result.days[0].nextActivityCursor });
    assert.equal(more.items.length, 5);
    assert.equal(new Set([...result.days[0].activity, ...more.items].map((a) => a.id)).size, 105);
    assert.equal((await history.getSummary(busy._id)).incoming, 105);
  });
  await t.test("empty and unconfirmed activity return zero totals and no fake records", async () => {
    const empty = await account();
    const summary = await history.getSummary(empty._id, {});
    assert.equal(summary.incoming, 0); assert.equal(summary.outgoing, 0); assert.equal(summary.netChange, 0);
    assert.equal(summary.coverage.firstRecordedAt, null);
    for (const status of ["pending", "failed"]) await TokenOperation.create({ key: `not-confirmed:${randomUUID()}`, kind: "topup", status,
      entries: [{ user: empty._id, delta: 999, balance: 20999, balanceVersion: 1 }] });
    assert.deepEqual((await history.getHistory(empty._id, {})).days, []);
    assert.deepEqual((await history.getHistory(empty._id, { mode: "detailed" })).items, []);
    assert.equal((await history.getSummary(empty._id, {})).operationCount, 0);
  });
  await t.test("v2 snapshots the conversation context in its existing billing transaction", async () => {
    const v2User = await account();
    const chat = await ChatConversation.create({ user: v2User._id, title: "Snapshot title" });
    const session = await mongoose.startSession();
    const charge = { userId: v2User._id, modelId: "history-model", conversationId: chat._id, turnId: `snapshot:${randomUUID()}`,
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 }, session };
    try { await session.withTransaction(() => finalizeCharge.finalizeChargeInTransaction(charge));
      await session.withTransaction(() => finalizeCharge.finalizeChargeInTransaction(charge));
    } finally { await session.endSession(); }
    await ChatConversation.findByIdAndUpdate(chat._id, { title: "Renamed" });
    const result = await history.getHistory(v2User._id, { mode: "detailed" });
    assert.equal(result.items.length, 1); assert.equal(result.items[0].amount, -50);
    assert.equal(result.items[0].chat, "Snapshot title"); assert.equal(result.items[0].conversationId, String(chat._id));
    assert.equal((await ledger.getBalance(v2User._id)).appTokens, 19950);
  });
  await t.test("HTTP routes require auth, reject bad input, and do not expose other accounts", async () => {
    const express = require("express"), jwt = require("jsonwebtoken");
    const previousEnv = {};
    for (const [key, value] of Object.entries({ JWT_SECRET: "history-test-only", OPENAI_API_KEY: "test-unused-openai-key", STRIPE_SECRET_KEY: "sk_test_unused_history" })) {
      previousEnv[key] = process.env[key]; process.env[key] = value;
    }
    t.after(() => { for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    } });
    const app = express(); app.use("/users", require("../src/routes/user"));
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const authToken = jwt.sign({ userId: String(user._id) }, process.env.JWT_SECRET);
    const headers = { Authorization: `Bearer ${authToken}` };
    const unauth = await fetch(origin + "/users/token-history"); assert.equal(unauth.status, 401);
    for (const path of ["/users/token-history?mode=detailed", "/users/token-history/summary", "/users/token-history/days/2026-10-11/charges?timeZone=Europe%2FKyiv"]) {
      const response = await fetch(origin + path, { headers }); assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert(!JSON.stringify(await response.json()).includes("987654"));
    }
    for (const path of ["/users/token-history?timeZone=bad", "/users/token-history?from=2026-02-30", "/users/token-history/days/not-a-date/charges"]) {
      assert.equal((await fetch(origin + path, { headers })).status, 400);
    }
  });
});
