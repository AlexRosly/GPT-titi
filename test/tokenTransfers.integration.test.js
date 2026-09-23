require("dotenv").config({ quiet: true });

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");

// Never fall back to the application's MONGO_URI. The suite owns only this
// randomly named database, even when the explicit test URI contains a db name.
const TEST_MONGO_URI =
  process.env.TOKEN_TRANSFER_TEST_MONGO_URI || process.env.CHAT_V2_TEST_MONGO_URI;
const TEST_DB_NAME = `token_transfer_test_${process.pid}_${randomUUID().slice(0, 8)}`;

test(
  "token transfers against a real MongoDB replica set",
  {
    skip: TEST_MONGO_URI
      ? false
      : "Set TOKEN_TRANSFER_TEST_MONGO_URI to a MongoDB replica set/Atlas test cluster.",
    timeout: 120000,
  },
  async (t) => {
    const { User, TokenTransfer } = require("../src/models");
    const { checkRecipient, transferTokens } = require("../src/services/tokenTransfers");

    t.after(async () => {
      try {
        if (mongoose.connection.readyState === 1) {
          assert.equal(mongoose.connection.db.databaseName, TEST_DB_NAME);
          assert.match(TEST_DB_NAME, /^token_transfer_test_\d+_[0-9a-f-]+$/);
          await mongoose.connection.db.dropDatabase();
        }
      } finally {
        await mongoose.disconnect();
      }
    });

    await mongoose.connect(TEST_MONGO_URI, {
      dbName: TEST_DB_NAME,
      serverSelectionTimeoutMS: 10000,
    });
    await Promise.all([User.createIndexes(), TokenTransfer.createIndexes()]);

    const createUser = (overrides = {}) =>
      User.create({
        email: `transfer-${randomUUID()}@example.test`,
        name: "Token transfer integration test",
        status: "active",
        appTokens: 100,
        ...overrides,
      });

    const fixture = async (recipientOverrides = {}, senderOverrides = {}) => {
      const [sender, recipient] = await Promise.all([
        createUser(senderOverrides),
        createUser({ appTokens: 20, ...recipientOverrides }),
      ]);
      return {
        sender,
        recipient,
        payload: {
          userId: sender._id,
          email: recipient.email,
          amount: 30,
          clientTransferId: randomUUID(),
        },
      };
    };

    const expectError = (code, status, details) => (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      if (details) {
        for (const [key, value] of Object.entries(details)) {
          assert.equal(error.details[key], value);
        }
      }
      return true;
    };

    const assertState = async (sender, recipient, expected) => {
      const [storedSender, storedRecipient, transfers] = await Promise.all([
        User.findById(sender._id).lean(),
        User.findById(recipient._id).lean(),
        TokenTransfer.countDocuments({ sender: sender._id }),
      ]);
      assert.equal(storedSender.appTokens, expected.senderBalance);
      assert.equal(storedRecipient.appTokens, expected.recipientBalance);
      assert.equal(storedRecipient.status, expected.recipientStatus || recipient.status);
      assert.equal(transfers, expected.transfers || 0);
    };

    for (const status of ["active", "blocked"]) {
      await t.test(`lookup accepts ${status} recipients without changing their status`, async () => {
        const { sender, recipient, payload } = await fixture({ status });
        const result = await checkRecipient(payload);
        assert.equal(result.success, true);
        assert.equal(result.canTransfer, true);
        assert.equal(result.recipient.email, recipient.email);
        assert.equal(result.recipient.status, status);
        assert.equal(result.appTokens, 100);
        await assertState(sender, recipient, { senderBalance: 100, recipientBalance: 20 });
      });

      await t.test(`transfer credits ${status} recipients and leaves them active`, async () => {
        const { sender, recipient, payload } = await fixture({ status });
        const result = await transferTokens(payload);
        assert.equal(result.success, true);
        assert.equal(result.alreadyApplied, false);
        assert.equal(result.appTokens, 70);
        assert.equal(result.transfer.clientTransferId, payload.clientTransferId);
        assert.equal(result.transfer.email, recipient.email);
        assert.equal(result.transfer.amount, 30);
        assert.ok(result.transfer.id);
        assert.ok(Number.isFinite(new Date(result.transfer.createdAt).getTime()));
        await assertState(sender, recipient, {
          senderBalance: 70,
          recipientBalance: 50,
          recipientStatus: "active",
          transfers: 1,
        });
        const ledger = await TokenTransfer.findOne({ sender: sender._id }).lean();
        assert.equal(String(ledger.recipient), String(recipient._id));
        assert.equal(ledger.recipientEmail, recipient.email);
        assert.equal(ledger.amount, 30);
        assert.equal(ledger.senderBalance, 70);
      });
    }

    await t.test("deleted and missing recipients are rejected by lookup and transfer", async () => {
      const { sender, recipient, payload } = await fixture({ status: "deleted" });
      for (const operation of [checkRecipient, transferTokens]) {
        await assert.rejects(operation(payload), expectError("RECIPIENT_DELETED", 409));
        await assert.rejects(
          operation({ ...payload, email: `missing-${randomUUID()}@example.test` }),
          expectError("RECIPIENT_NOT_FOUND", 404),
        );
      }
      await assertState(sender, recipient, { senderBalance: 100, recipientBalance: 20 });
    });

    await t.test("email matching is literal, case insensitive, and trims whitespace", async () => {
      const suffix = randomUUID();
      const sender = await createUser();
      const decoy = await createUser({ email: `literalXfirst${suffix}@example.test` });
      const recipient = await createUser({ email: `Literal.First+${suffix}@Example.Test` });
      const payload = {
        userId: sender._id,
        email: `  ${recipient.email.toUpperCase()}  `,
        amount: 10,
        clientTransferId: randomUUID(),
      };
      const result = await checkRecipient(payload);
      assert.equal(result.recipient.email.toLowerCase(), recipient.email.toLowerCase());
      await transferTokens(payload);
      assert.equal((await User.findById(recipient._id).lean()).appTokens, 110);
      assert.equal((await User.findById(decoy._id).lean()).appTokens, 100);
    });

    await t.test("self transfers are rejected even with different email casing", async () => {
      const { sender, recipient, payload } = await fixture();
      payload.email = ` ${sender.email.toUpperCase()} `;
      for (const operation of [checkRecipient, transferTokens]) {
        await assert.rejects(operation(payload), expectError("SELF_TRANSFER", 400));
      }
      await assertState(sender, recipient, { senderBalance: 100, recipientBalance: 20 });
    });

    await t.test("ambiguous legacy email casing cannot select a recipient", async () => {
      const email = `legacy-${randomUUID()}@example.test`;
      const { sender, recipient, payload } = await fixture({ email });
      const duplicate = await createUser({ email: email.toUpperCase() });
      for (const operation of [checkRecipient, transferTokens]) {
        await assert.rejects(operation(payload), expectError("RECIPIENT_UNAVAILABLE", 409));
      }
      await assertState(sender, recipient, { senderBalance: 100, recipientBalance: 20 });
      assert.equal((await User.findById(duplicate._id).lean()).appTokens, 100);
    });

    await t.test("invalid inputs never mutate either balance", async () => {
      const { sender, recipient, payload } = await fixture({ status: "blocked" });
      for (const email of [undefined, null, "", " ", "no-at-sign", "name@", "a b@example.test", [], { $ne: null }]) {
        for (const operation of [checkRecipient, transferTokens]) {
          await assert.rejects(operation({ ...payload, email }), expectError("INVALID_EMAIL", 400));
        }
      }
      for (const amount of [undefined, null, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "30", true, {}, []]) {
        await assert.rejects(transferTokens({ ...payload, amount }), expectError("INVALID_AMOUNT", 400));
      }
      for (const clientTransferId of [undefined, null, "", "not-a-uuid", "00000000-0000-1000-8000-000000000000", {}]) {
        await assert.rejects(
          transferTokens({ ...payload, clientTransferId }),
          expectError("INVALID_CLIENT_TRANSFER_ID", 400),
        );
      }
      await assertState(sender, recipient, { senderBalance: 100, recipientBalance: 20 });
    });

    await t.test("the entire available balance can be transferred", async () => {
      const { sender, recipient, payload } = await fixture();
      const result = await transferTokens({ ...payload, amount: 100 });
      assert.equal(result.appTokens, 0);
      await assertState(sender, recipient, {
        senderBalance: 0,
        recipientBalance: 120,
        transfers: 1,
      });
    });

    await t.test("insufficient funds do not reactivate or credit a blocked recipient", async () => {
      const { sender, recipient, payload } = await fixture({ status: "blocked" });
      await assert.rejects(
        transferTokens({ ...payload, amount: 101 }),
        expectError("INSUFFICIENT_BALANCE", 409, { appTokens: 100 }),
      );
      await assertState(sender, recipient, { senderBalance: 100, recipientBalance: 20 });
    });

    await t.test("recipient balance overflow rolls back the debit and reactivation", async () => {
      const recipientBalance = Number.MAX_SAFE_INTEGER - 1;
      const { sender, recipient, payload } = await fixture({
        status: "blocked",
        appTokens: recipientBalance,
      });
      await assert.rejects(transferTokens(payload), expectError("RECIPIENT_UNAVAILABLE", 409));
      await assertState(sender, recipient, { senderBalance: 100, recipientBalance });
    });

    await t.test("lookup does not authorize transfers after recipient deletion", async () => {
      const { sender, recipient, payload } = await fixture();
      await checkRecipient(payload);
      await User.updateOne({ _id: recipient._id }, { $set: { status: "deleted" } });
      await assert.rejects(transferTokens(payload), expectError("RECIPIENT_DELETED", 409));
      await assertState(sender, recipient, {
        senderBalance: 100,
        recipientBalance: 20,
        recipientStatus: "deleted",
      });
    });

    await t.test("transfer uses the current balance after a successful lookup", async () => {
      const { sender, recipient, payload } = await fixture();
      assert.equal((await checkRecipient(payload)).appTokens, 100);
      await User.updateOne({ _id: sender._id }, { $set: { appTokens: 5 } });
      await assert.rejects(
        transferTokens(payload),
        expectError("INSUFFICIENT_BALANCE", 409, { appTokens: 5 }),
      );
      await assertState(sender, recipient, { senderBalance: 5, recipientBalance: 20 });
    });

    for (const status of ["blocked", "deleted"]) {
      await t.test(`a sender becoming ${status} after lookup cannot transfer`, async () => {
        const { sender, recipient, payload } = await fixture();
        await checkRecipient(payload);
        await User.updateOne({ _id: sender._id }, { $set: { status } });
        for (const operation of [checkRecipient, transferTokens]) {
          await assert.rejects(operation(payload), (error) => {
            assert.equal(error.status, 403);
            return true;
          });
        }
        await assertState(sender, recipient, { senderBalance: 100, recipientBalance: 20 });
      });
    }

    await t.test("retry with the same id and normalized email applies only once", async () => {
      const { sender, recipient, payload } = await fixture();
      const first = await transferTokens(payload);
      const retry = await transferTokens({
        ...payload,
        email: ` ${recipient.email.toUpperCase()} `,
        clientTransferId: payload.clientTransferId.toUpperCase(),
      });
      assert.equal(first.alreadyApplied, false);
      assert.equal(retry.alreadyApplied, true);
      assert.equal(String(retry.transfer.id), String(first.transfer.id));
      assert.equal(retry.transfer.amount, first.transfer.amount);
      assert.equal(retry.transfer.clientTransferId, payload.clientTransferId);
      await assertState(sender, recipient, { senderBalance: 70, recipientBalance: 50, transfers: 1 });
    });

    await t.test("reusing a transfer id with another amount or recipient fails", async () => {
      const { sender, recipient, payload } = await fixture();
      const other = await createUser();
      await transferTokens(payload);
      for (const change of [{ amount: 31 }, { email: other.email }]) {
        await assert.rejects(
          transferTokens({ ...payload, ...change }),
          expectError("IDEMPOTENCY_CONFLICT", 409),
        );
      }
      await assertState(sender, recipient, { senderBalance: 70, recipientBalance: 50, transfers: 1 });
      assert.equal((await User.findById(other._id).lean()).appTokens, 100);
    });

    await t.test("idempotency keys are scoped to the authenticated sender", async () => {
      const { sender, recipient, payload } = await fixture();
      const secondSender = await createUser();
      await transferTokens(payload);
      await transferTokens({ ...payload, userId: secondSender._id });
      await assertState(sender, recipient, { senderBalance: 70, recipientBalance: 80, transfers: 1 });
      assert.equal((await User.findById(secondSender._id).lean()).appTokens, 70);
      assert.equal(await TokenTransfer.countDocuments({ clientTransferId: payload.clientTransferId }), 2);
    });

    await t.test("simultaneous retries commit one debit, credit, and ledger entry", async () => {
      const { sender, recipient, payload } = await fixture({ status: "blocked" });
      const results = await Promise.all(Array.from({ length: 4 }, () => transferTokens(payload)));
      assert.equal(new Set(results.map((result) => String(result.transfer.id))).size, 1);
      assert.equal(results.filter((result) => result.alreadyApplied === false).length, 1);
      assert.equal(results.filter((result) => result.alreadyApplied === true).length, 3);
      await assertState(sender, recipient, {
        senderBalance: 70,
        recipientBalance: 50,
        recipientStatus: "active",
        transfers: 1,
      });
    });

    await t.test("concurrent distinct transfers cannot overspend the sender", async () => {
      const { sender, recipient, payload } = await fixture({ appTokens: 0 });
      const other = await createUser({ appTokens: 0 });
      const results = await Promise.allSettled([
        transferTokens({ ...payload, amount: 80 }),
        transferTokens({ ...payload, amount: 80, email: other.email, clientTransferId: randomUUID() }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const failures = results.filter((result) => result.status === "rejected");
      assert.equal(failures.length, 1);
      expectError("INSUFFICIENT_BALANCE", 409, { appTokens: 20 })(failures[0].reason);
      const balances = await User.find({ _id: { $in: [sender._id, recipient._id, other._id] } }).lean();
      assert.equal(balances.find((user) => String(user._id) === String(sender._id)).appTokens, 20);
      assert.equal(balances.reduce((sum, user) => sum + user.appTokens, 0), 100);
      assert.ok(balances.every((user) => user.appTokens >= 0));
      assert.equal(await TokenTransfer.countDocuments({ sender: sender._id }), 1);
    });

    await t.test("credit failure rolls back a real sender debit and permits retry", async (subtest) => {
      const { sender, recipient, payload } = await fixture({ status: "blocked" });
      const original = User.collection.findOneAndUpdate;
      let debitWrites = 0;
      const mockedWrite = subtest.mock.method(User.collection, "findOneAndUpdate", async function (filter, update, ...args) {
        if (String(filter._id) === String(recipient._id) && update.$inc?.appTokens > 0) {
          throw new Error("Injected recipient credit failure");
        }
        const result = await original.call(this, filter, update, ...args);
        if (String(filter._id) === String(sender._id) && update.$inc?.appTokens < 0) debitWrites += 1;
        return result;
      });
      await assert.rejects(transferTokens(payload), /Injected recipient credit failure/);
      assert.equal(debitWrites, 1, "a database debit must precede the injected failure");
      await assertState(sender, recipient, { senderBalance: 100, recipientBalance: 20 });
      mockedWrite.mock.restore();
      await transferTokens(payload);
      await assertState(sender, recipient, { senderBalance: 70, recipientBalance: 50, recipientStatus: "active", transfers: 1 });
    });

    await t.test("ledger failure rolls back both balances and recipient reactivation", async (subtest) => {
      const { sender, recipient, payload } = await fixture({ status: "blocked" });
      const mockedCreate = subtest.mock.method(TokenTransfer, "create", async () => {
        throw new Error("Injected transfer ledger failure");
      });
      await assert.rejects(transferTokens(payload), /Injected transfer ledger failure/);
      assert.equal(mockedCreate.mock.callCount(), 1);
      await assertState(sender, recipient, { senderBalance: 100, recipientBalance: 20 });
      mockedCreate.mock.restore();
      await transferTokens(payload);
      await assertState(sender, recipient, { senderBalance: 70, recipientBalance: 50, recipientStatus: "active", transfers: 1 });
    });
  },
);
