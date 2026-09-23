const test = require("node:test");
const assert = require("node:assert/strict");
const { User, ChatModels } = require("../src/models");
const { APP_TOKEN_VALUE_USD } = require("../src/config/billing");
const finalizeCharge = require("../src/services/finalizeCharge");

const charge = (userId = "sender") => finalizeCharge({
  userId,
  modelId: "billing-test-model",
  usage: { prompt_tokens: 100, completion_tokens: 0 },
});

const mockModelPrice = (t) => {
  t.mock.method(ChatModels, "findOne", () => ({
    lean: async () => ({ inputPerM: APP_TOKEN_VALUE_USD * 1_000_000, outputPerM: 0 }),
  }));
};

// Simulate a transfer committing immediately before the charge write. A document
// read still holds its old balance; an atomic increment applies to the live one.
const mockAccount = (t, { balance, transferDelta = 0, exists = true }) => {
  const account = { balance };
  let transferPending = true;
  const commitTransfer = () => {
    if (transferPending) {
      account.balance += transferDelta;
      transferPending = false;
    }
  };

  t.mock.method(User, "findById", async () => {
    if (!exists) return null;
    return {
      appTokens: account.balance,
      async save() {
        commitTransfer();
        account.balance = this.appTokens;
      },
    };
  });
  t.mock.method(User, "findByIdAndUpdate", async (_id, update) => {
    if (!exists) return null;
    commitTransfer();
    account.balance += update.$inc.appTokens;
    return { appTokens: account.balance };
  });

  return account;
};

test("legacy billing preserves a concurrent outgoing token transfer", async (t) => {
  mockModelPrice(t);
  const account = mockAccount(t, { balance: 1000, transferDelta: -400 });

  const result = await charge();

  assert.equal(result.appTokens, 100);
  assert.equal(result.balance, 500);
  assert.equal(account.balance, 500);
});

test("legacy billing preserves a concurrent incoming token transfer", async (t) => {
  mockModelPrice(t);
  const account = mockAccount(t, { balance: 1000, transferDelta: 400 });

  const result = await charge("recipient");

  assert.equal(result.balance, 1300);
  assert.equal(account.balance, 1300);
});

test("simultaneous legacy charges both reduce the balance", async (t) => {
  mockModelPrice(t);
  const account = mockAccount(t, { balance: 1000 });

  await Promise.all([charge(), charge()]);

  assert.equal(account.balance, 800);
});

test("legacy billing retains its existing negative-balance behavior", async (t) => {
  mockModelPrice(t);
  const account = mockAccount(t, { balance: 25 });

  const result = await charge();

  assert.equal(result.balance, -75);
  assert.equal(account.balance, -75);
});

test("legacy billing still rejects a missing user", async (t) => {
  mockModelPrice(t);
  mockAccount(t, { balance: 1000, exists: false });

  await assert.rejects(charge(), /User not found/);
});
