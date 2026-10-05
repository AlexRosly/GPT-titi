const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const http = require("node:http");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { io: connect } = require("socket.io-client");
const { User, TokenTransfer, TokenOperation, BalanceOutbox, ChatModels } = require("../src/models");
const ledger = require("../src/services/tokenLedger");
const { transferTokens } = require("../src/services/tokenTransfers");
const { createOutboxWorker } = require("../src/services/balanceOutbox");
const { createBalanceBus } = require("../src/services/balanceEvents");

const uri = process.env.TOKEN_TRANSFER_TEST_MONGO_URI || process.env.CHAT_V2_TEST_MONGO_URI;
const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for balance event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("token ledger and reliable balance notifications", { skip: !uri, timeout: 60000 }, async (t) => {
  const dbName = `balance_sync_test_${process.pid}_${randomUUID().slice(0, 8)}`;
  await mongoose.connect(uri, { dbName });
  t.after(async () => {
    assert.equal(mongoose.connection.db.databaseName, dbName);
    assert.match(dbName, /^balance_sync_test_\d+_[0-9a-f-]+$/);
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  });
  await Promise.all([User, TokenTransfer, TokenOperation, BalanceOutbox].map((model) => model.createIndexes()));
  const user = (appTokens = 100) => User.create({ email: `${randomUUID()}@example.test`, appTokens });
  const transfer = (sender, recipient, amount = 30, clientTransferId = randomUUID()) =>
    transferTokens({ userId: sender._id, email: recipient.email, amount, clientTransferId });

  await t.test("a transfer commits both versions, one operation and two outbox records exactly once", async () => {
    const [sender, recipient] = await Promise.all([user(), user(0)]);
    const id = randomUUID();
    const result = await transfer(sender, recipient, 30, id);
    await transfer(sender, recipient, 30, id);
    assert.equal(result.operation.status, "confirmed");
    assert.equal(result.balanceVersion, 1);
    assert.equal((await ledger.getBalance(recipient._id)).balanceVersion, 1);
    assert.equal(await TokenOperation.countDocuments({ "entries.user": sender._id }), 1);
    assert.equal(await BalanceOutbox.countDocuments({ operation: result.operation.id }), 2);
    await ledger.credit({ userId: sender._id, amount: 10, kind: "topup", key: `credit:${id}` });
    const replay = await transfer(sender, recipient, 30, id);
    assert.equal(replay.appTokens, 70, "receipt is historical");
    assert.equal((await ledger.getBalance(sender._id)).appTokens, 80, "control GET is current");
    assert.equal((await ledger.getBalance(sender._id)).balanceVersion, 2);
    assert.equal((await ledger.getOperation(sender._id, result.operation.id)).balance, 70);
    const outsider = await user();
    await assert.rejects(ledger.getOperation(outsider._id, result.operation.id), { code: "OPERATION_NOT_FOUND" });
  });

  await t.test("outbox failure rolls back both account mutations", async (subtest) => {
    const [sender, recipient] = await Promise.all([user(), user(0)]);
    const stub = subtest.mock.method(BalanceOutbox, "create", async () => { throw new Error("outbox unavailable"); });
    await assert.rejects(transfer(sender, recipient), /outbox unavailable/);
    stub.mock.restore();
    assert.equal((await ledger.getBalance(sender._id)).appTokens, 100);
    assert.equal((await ledger.getBalance(sender._id)).balanceVersion, 0);
    assert.equal((await ledger.getBalance(recipient._id)).appTokens, 0);
    assert.equal(await TokenOperation.countDocuments({ "entries.user": sender._id }), 0);
  });

  await t.test("the ledger interface itself preserves transfer idempotency and rejects changed recipients", async () => {
    const [sender, recipient, other] = await Promise.all([user(), user(0), user(0)]);
    const request = { senderId: sender._id, recipientId: recipient._id, amount: 30, key: `ledger-transfer:${randomUUID()}` };
    await Promise.all([ledger.transfer(request), ledger.transfer(request)]);
    assert.equal((await ledger.getBalance(sender._id)).appTokens, 70);
    assert.equal((await ledger.getBalance(recipient._id)).appTokens, 30);
    assert.equal((await ledger.getBalance(sender._id)).balanceVersion, 1);
    await assert.rejects(ledger.transfer({ ...request, recipientId: other._id }), { code: "IDEMPOTENCY_CONFLICT" });
    await assert.rejects(ledger.transfer({ ...request, recipientId: sender._id }), { code: "SELF_TRANSFER" });
  });

  await t.test("bonus claims and duplicate credits remain safe under concurrency", async () => {
    const account = await user(0);
    const results = await Promise.all([ledger.claimBonus({ userId: account._id }), ledger.claimBonus({ userId: account._id })]);
    assert.equal(results.filter((result) => result.success).length, 1);
    const key = `topup:${randomUUID()}`;
    await Promise.all(Array.from({ length: 4 }, () => ledger.credit({ userId: account._id, amount: 10, kind: "topup", key })));
    assert.equal((await ledger.getBalance(account._id)).appTokens, 10010);
    assert.equal((await ledger.getBalance(account._id)).balanceVersion, 2);
  });

  await t.test("registration bonus is journalled and refund replay cannot remove tokens twice", async () => {
    const account = await ledger.createAccount({ email: `${randomUUID()}@example.test` });
    assert.equal(account.appTokens, 10000);
    assert.equal(account.balanceVersion, 1);
    assert.equal(await TokenOperation.countDocuments({ "entries.user": account._id, kind: "registration_bonus" }), 1);
    const key = `refund:${randomUUID()}`;
    await ledger.refund({ userId: account._id, amount: 20000, key });
    await ledger.credit({ userId: account._id, amount: 100, kind: "topup" });
    const replay = await ledger.refund({ userId: account._id, amount: 20000, key });
    assert.equal(replay.alreadyApplied, true);
    assert.equal((await ledger.getBalance(account._id)).appTokens, -900);
    assert.equal((await ledger.getBalance(account._id)).balanceVersion, 3);
    await assert.rejects(ledger.refund({ userId: account._id, amount: 10000, key }), { code: "IDEMPOTENCY_CONFLICT" });
  });

  await t.test("signed Stripe purchase/refund retries mutate balances and journal only once", async (subtest) => {
    const express = require("express");
    const { Payment, Price } = require("../src/models");
    await Payment.createIndexes();
    const previous = process.env.STRIPE_WEBHOOK_SECRET;
    const secret = `whsec_${randomUUID()}`;
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    subtest.after(() => { if (previous === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = previous; });
    const stripe = require("../src/services/stripe");
    const app = express();
    app.post("/webhook", express.raw({ type: "application/json" }), require("../src/controllers/billing/stripeWebhook"));
    const server = app.listen(0, "127.0.0.1");
    subtest.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    await once(server, "listening");
    const account = await user(10);
    const priceId = `price_${randomUUID()}`;
    const checkoutId = `cs_${randomUUID()}`;
    const intentId = `pi_${randomUUID()}`;
    await Price.create({ stripePriceId: priceId, appTokens: 100, amount: 199, currency: "usd" });
    const webhook = async (event) => {
      const body = JSON.stringify(event);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
        method: "POST", body, headers: { "Content-Type": "application/json",
          "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload: body, secret }) },
      });
      assert.equal(response.status, 200, await response.text());
    };
    const purchase = { id: `evt_${randomUUID()}`, type: "checkout.session.completed", data: { object: {
      id: checkoutId, payment_status: "paid", metadata: { userId: String(account._id), priceId },
      payment_intent: intentId, currency: "usd", amount_total: 199,
    } } };
    await webhook(purchase);
    await webhook(purchase);
    assert.equal((await ledger.getBalance(account._id)).appTokens, 110);
    const refund = { id: `evt_${randomUUID()}`, type: "charge.refunded", data: { object: {
      id: `ch_${randomUUID()}`, refunded: true, payment_intent: intentId,
    } } };
    await webhook(refund);
    await webhook(refund);
    assert.equal((await ledger.getBalance(account._id)).appTokens, 10);
    assert.equal((await ledger.getBalance(account._id)).balanceVersion, 2);
    assert.equal(await TokenOperation.countDocuments({ "entries.user": account._id }), 2);
    assert.equal(await BalanceOutbox.countDocuments({ user: account._id }), 2);
  });

  await t.test("real chat billing and transfer retain concurrent balance changes", async () => {
    const [sender, recipient] = await Promise.all([user(1000), user(0)]);
    await ChatModels.create({ modelId: "balance-test", inputPerM: 1, outputPerM: 0 });
    const charge = require("../src/services/finalizeCharge");
    const cost = await require("../src/utils/calculateModelCost")({ modelId: "balance-test", inputTokens: 100, outputTokens: 0 });
    await Promise.all([transfer(sender, recipient, 30), charge({ userId: sender._id, modelId: "balance-test", usage: { prompt_tokens: 100 } })]);
    const balance = await ledger.getBalance(sender._id);
    assert.equal(balance.appTokens, 1000 - 30 - cost.appTokens);
    assert.equal(balance.balanceVersion, 2);
  });

  await t.test("a failed publication is retried by a new worker without another debit", async () => {
    await BalanceOutbox.deleteMany({});
    const [sender, recipient] = await Promise.all([user(), user(0)]);
    await transfer(sender, recipient);
    const failed = createOutboxWorker({ bus: { publish: async () => { throw new Error("Redis offline"); } } });
    await failed.drain();
    await failed.stop();
    assert.equal(await BalanceOutbox.countDocuments({ deliveredAt: null }), 2);
    await BalanceOutbox.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    const delivered = [];
    const recovered = createOutboxWorker({ bus: { publish: async (event) => delivered.push(event) } });
    await recovered.drain();
    await recovered.stop();
    assert.equal(delivered.length, 2);
    assert.equal(await BalanceOutbox.countDocuments({ deliveredAt: null }), 0);
    assert.equal((await ledger.getBalance(sender._id)).appTokens, 70);
  });

  await t.test("Redis forwards across backend instances and tabs, with authenticated room and environment isolation", {
    skip: !process.env.BALANCE_SYNC_TEST_REDIS_URL,
  }, async (subtest) => {
    await BalanceOutbox.deleteMany({});
    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = randomUUID();
    subtest.after(() => { if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret; });
    const namespace = `balance-test:${randomUUID()}`;
    const servers = [];
    const buses = [];
    const sockets = [];
    subtest.after(async () => {
      sockets.forEach((socket) => socket.disconnect());
      await Promise.all(buses.map((bus) => bus.close()));
      await Promise.all(servers.map(({ io }) => new Promise((resolve) => io.close(resolve))));
    });
    for (const prefix of [namespace, namespace, `${namespace}:another-env`]) {
      const server = http.createServer();
      const io = new Server(server);
      io.use(require("../src/middlewares/authSocket"));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      servers.push({ server, io });
      buses.push(await createBalanceBus({ io, transport: "redis", redisUrl: process.env.BALANCE_SYNC_TEST_REDIS_URL, namespace: prefix }));
    }
    const [sender, recipient, outsider] = await Promise.all([user(), user(0), user()]);
    const client = async (instance, account, token = jwt.sign({ userId: String(account._id) }, process.env.JWT_SECRET)) => {
      const socket = connect(`http://127.0.0.1:${servers[instance].server.address().port}`, {
        transports: ["websocket"], auth: { token }, autoConnect: false, reconnection: false,
      });
      const events = [];
      const syncs = [];
      socket.on("balance.updated", (event) => events.push(event));
      socket.on("balance.sync", (event) => syncs.push(event));
      sockets.push(socket);
      const connected = once(socket, "connect");
      socket.connect();
      await connected;
      return { socket, events, syncs };
    };
    const senderTab = await client(0, sender);
    const recipientTab1 = await client(1, recipient);
    const recipientTab2 = await client(0, recipient);
    const privateTab = await client(1, outsider);
    const otherEnvTab = await client(2, recipient);
    const unauthorized = connect(`http://127.0.0.1:${servers[0].server.address().port}`, { autoConnect: false, reconnection: false });
    sockets.push(unauthorized);
    const rejected = once(unauthorized, "connect_error");
    unauthorized.connect();
    assert.match((await rejected)[0].message, /Unauthorized/);
    const result = await transfer(sender, recipient);
    const worker = createOutboxWorker({ bus: buses[0] });
    await worker.drain();
    await worker.stop();
    await waitFor(() => recipientTab1.events.length && recipientTab2.events.length && senderTab.events.length);
    for (const tab of [recipientTab1, recipientTab2]) {
      assert.equal(tab.events[0].userId, String(recipient._id));
      assert.equal(tab.events[0].operationId, result.operation.id);
      assert.equal(tab.events[0].balanceVersion, 1);
      assert.equal(tab.events[0].appTokens, undefined, "events invalidate; GET supplies truth");
    }
    assert.equal(privateTab.events.length, 0);
    assert.equal(otherEnvTab.events.length, 0);

    // Force only this test namespace's subscriber connections to reconnect.
    const Redis = require("ioredis");
    const admin = new Redis(process.env.BALANCE_SYNC_TEST_REDIS_URL);
    subtest.after(() => admin.disconnect());
    const clients = (await admin.client("LIST")).split("\n");
    const ids = clients.filter((line) => line.includes(`name=${namespace}:subscriber `))
      .map((line) => line.match(/^id=(\d+)/)[1]);
    assert.equal(ids.length, 2);
    for (const id of ids) await admin.client("KILL", "ID", id);
    await waitFor(() => recipientTab1.syncs.length && recipientTab2.syncs.length);
    assert.equal(recipientTab1.syncs[0].reason, "redis_reconnected");
    assert.equal((await ledger.getBalance(recipient._id)).appTokens, 30);
  });
});
