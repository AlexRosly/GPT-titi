require("dotenv").config({ quiet: true });

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const test = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const TEST_MONGO_URI =
  process.env.TOKEN_TRANSFER_TEST_MONGO_URI || process.env.CHAT_V2_TEST_MONGO_URI;
const TEST_DB_NAME = `token_http_test_${process.pid}_${randomUUID().slice(0, 8)}`;
const ROUTE = "/gpt-titi/api/users";

test("token transfer HTTP routes", { timeout: 45000 }, async (t) => {
  // The real user router imports other service clients. Give those clients
  // inert credentials; no application server, cron, or external API is started.
  const previousEnv = {};
  for (const [key, value] of Object.entries({
    JWT_SECRET: randomUUID(),
    OPENAI_API_KEY: "test-unused-openai-key",
    STRIPE_SECRET_KEY: "sk_test_unused_http_routes",
  })) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const app = express();
  app.use(express.json());
  app.use(ROUTE, require("../src/routes/user"));
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;

  const request = async (path, { token, body, method = "GET" } = {}) => {
    const response = await fetch(`${origin}${ROUTE}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { response, body: await response.json() };
  };

  await t.test("both endpoints require authentication", async () => {
    for (const [path, method] of [
      ["/token-transfers/recipient?email=someone%40example.test", "GET"],
      ["/token-transfers", "POST"],
    ]) {
      for (const token of [undefined, "invalid-jwt", jwt.sign({ userId: new mongoose.Types.ObjectId() }, "wrong-secret")]) {
        const result = await request(path, { method, token });
        assert.equal(result.response.status, 401);
        assert.ok(result.body.error);
      }
    }
  });

  await t.test(
    "authenticated HTTP contract with real MongoDB",
    {
      skip: TEST_MONGO_URI
        ? false
        : "Set TOKEN_TRANSFER_TEST_MONGO_URI to a MongoDB replica set/Atlas test cluster.",
    },
    async (dbTest) => {
      const { User, TokenTransfer } = require("../src/models");
      dbTest.after(async () => {
        try {
          if (mongoose.connection.readyState === 1) {
            assert.equal(mongoose.connection.db.databaseName, TEST_DB_NAME);
            assert.match(TEST_DB_NAME, /^token_http_test_\d+_[0-9a-f-]+$/);
            await mongoose.connection.db.dropDatabase();
          }
        } finally {
          await mongoose.disconnect();
        }
      });
      await mongoose.connect(TEST_MONGO_URI, { dbName: TEST_DB_NAME, serverSelectionTimeoutMS: 10000 });
      await Promise.all([User.createIndexes(), TokenTransfer.createIndexes()]);
      const [sender, recipient, other] = await User.create([
        { email: "sender@example.test", status: "active", appTokens: 100 },
        { email: "recipient@example.test", status: "blocked", appTokens: 10, refreshToken: "private-refresh-token" },
        { email: "other@example.test", status: "active", appTokens: 1000 },
      ]);
      const token = jwt.sign({ userId: sender._id.toString() }, process.env.JWT_SECRET, { expiresIn: "5m" });

      const lookup = await request("/token-transfers/recipient?email=%20RECIPIENT%40EXAMPLE.TEST%20", { token });
      assert.equal(lookup.response.status, 200);
      assert.equal(lookup.response.headers.get("cache-control"), "no-store");
      assert.equal(lookup.body.canTransfer, true);
      assert.equal(lookup.body.appTokens, 100);
      assert.deepEqual(lookup.body.recipient, { email: recipient.email, status: "blocked" });

      const body = {
        email: recipient.email,
        amount: 30,
        clientTransferId: randomUUID(),
        userId: other._id.toString(),
        sender: other._id.toString(),
      };
      const transfer = await request("/token-transfers", { token, body, method: "POST" });
      assert.equal(transfer.response.status, 200);
      assert.equal(transfer.response.headers.get("cache-control"), "no-store");
      assert.equal(transfer.body.success, true);
      assert.equal(transfer.body.appTokens, 70);
      assert.equal(transfer.body.alreadyApplied, false);
      assert.equal((await User.findById(sender._id).lean()).appTokens, 70);
      assert.equal((await User.findById(other._id).lean()).appTokens, 1000, "body fields must not select another sender");
      const credited = await User.findById(recipient._id).lean();
      assert.equal(credited.appTokens, 40);
      assert.equal(credited.status, "active");

      const retry = await request("/token-transfers", { token, body, method: "POST" });
      assert.equal(retry.response.status, 200);
      assert.equal(retry.body.alreadyApplied, true);
      assert.equal(retry.body.transfer.id, transfer.body.transfer.id);
      assert.equal(await TokenTransfer.countDocuments({ sender: sender._id }), 1);

      const insufficient = await request("/token-transfers", {
        token,
        body: { ...body, amount: 71, clientTransferId: randomUUID() },
        method: "POST",
      });
      assert.equal(insufficient.response.status, 409);
      assert.equal(insufficient.body.success, false);
      assert.equal(insufficient.body.code, "INSUFFICIENT_BALANCE");
      assert.equal(insufficient.body.appTokens, 70);
      assert.equal(insufficient.body.stack, undefined);

      await User.updateOne({ _id: recipient._id }, { $set: { status: "deleted" } });
      const deleted = await request("/token-transfers/recipient?email=recipient%40example.test", { token });
      assert.equal(deleted.response.status, 409);
      assert.equal(deleted.body.code, "RECIPIENT_DELETED");
      assert.equal(deleted.body.success, false);

      await User.updateOne({ _id: sender._id }, { $set: { status: "blocked" } });
      const forbidden = await request("/token-transfers", {
        token,
        body: { ...body, clientTransferId: randomUUID() },
        method: "POST",
      });
      assert.equal(forbidden.response.status, 403);
      assert.equal(forbidden.body.code, "SENDER_NOT_ALLOWED");
    },
  );
});
