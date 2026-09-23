const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { User } = require("../src/models");
const { checkRecipient, transferTokens, TokenTransferError } = require("../src/services/tokenTransfers");
const { getTransferRecipient, sendTokens } = require("../src/controllers/user/tokenTransfers");

const validRequest = () => ({
  userId: new mongoose.Types.ObjectId(),
  email: "recipient@example.com",
  amount: 100,
  clientTransferId: crypto.randomUUID(),
});

const errorWithCode = (code) => (error) => {
  assert.ok(error instanceof TokenTransferError);
  assert.equal(error.status, 400);
  assert.equal(error.code, code);
  return true;
};

test("invalid email types and query operators are rejected before reading accounts", async (t) => {
  const read = t.mock.method(User, "findById", () => {
    throw new Error("Unexpected account lookup");
  });
  const start = t.mock.method(mongoose, "startSession", () => {
    throw new Error("Unexpected transaction");
  });

  for (const email of [undefined, null, 123, [], {}, { $ne: null }, "", "  ", "a@b", "a@@b.com", "a b@example.com", `${"a".repeat(250)}@example.com`]) {
    await assert.rejects(checkRecipient({ userId: "sender", email }), errorWithCode("INVALID_EMAIL"));
    await assert.rejects(transferTokens({ ...validRequest(), email }), errorWithCode("INVALID_EMAIL"));
  }
  assert.equal(read.mock.callCount(), 0);
  assert.equal(start.mock.callCount(), 0);
});

test("amount accepts only positive safe integer numbers without coercion", async (t) => {
  const start = t.mock.method(mongoose, "startSession", () => {
    throw new Error("Unexpected transaction");
  });
  for (const amount of [undefined, null, false, true, "100", "1,000", "1e3", 0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, {}, [100]]) {
    await assert.rejects(transferTokens({ ...validRequest(), amount }), errorWithCode("INVALID_AMOUNT"));
  }
  assert.equal(start.mock.callCount(), 0);
});

test("missing and malformed idempotency ids are rejected before opening a transaction", async (t) => {
  const start = t.mock.method(mongoose, "startSession", () => {
    throw new Error("Unexpected transaction");
  });
  for (const clientTransferId of [undefined, null, {}, [], 5, "", "retry", "00000000-0000-0000-0000-000000000000", `${crypto.randomUUID()} `]) {
    await assert.rejects(transferTokens({ ...validRequest(), clientTransferId }), errorWithCode("INVALID_CLIENT_TRANSFER_ID"));
  }
  assert.equal(start.mock.callCount(), 0);
});

const response = () => ({
  statusCode: 200,
  headers: {},
  set(name, value) { this.headers[name] = value; return this; },
  status(value) { this.statusCode = value; return this; },
  json(value) { this.body = value; return this; },
});

test("missing transfer body produces a stable validation response", async () => {
  const res = response();
  await sendTokens({ user: { _id: "sender" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, "INVALID_EMAIL");
});

test("lookup does not expose internal database errors to the client", async (t) => {
  const error = new Error("private database connection detail");
  t.mock.method(User, "findById", () => ({ select: () => ({ lean: async () => { throw error; } }) }));
  const log = t.mock.fn();
  const res = response();
  await getTransferRecipient({
    user: { _id: "sender" },
    query: { email: "recipient@example.com" },
    log: { error: log },
  }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(res.body, { success: false, code: "INTERNAL_ERROR", message: "Internal server error." });
  assert.equal(log.mock.callCount(), 1);
  assert.equal(log.mock.calls[0].arguments[0].err, error);
});
