const test = require("node:test");
const assert = require("node:assert/strict");
const { User, TokenOperation, BalanceOutbox } = require("../src/models");
const ledger = require("../src/services/tokenLedger");
const { createOutboxWorker } = require("../src/services/balanceOutbox");

test("reservation changes keep money unchanged and enqueue an atomic versioned receipt", async (t) => {
  let mutation; let receipt; let notification;
  const session = {};
  t.mock.method(TokenOperation, "findOne", () => ({ session: () => ({ lean: async () => null }) }));
  t.mock.method(User, "findOneAndUpdate", (_filter, update, options) => {
    mutation = update; assert.equal(options.session, session);
    return { lean: async () => ({ _id: "user", appTokens: 100, reservedAppTokens: 20, balanceVersion: 5 }) };
  });
  t.mock.method(TokenOperation, "create", async ([value], options) => { receipt = value; assert.equal(options.session, session); return [{ ...value, _id: "receipt" }]; });
  t.mock.method(BalanceOutbox, "create", async (values, options) => { notification = values[0]; assert.equal(options.session, session); });
  const result = await ledger.changeReservation({ userId: "user", amount: 20, turnId: "turn", attempt: 1, session });
  assert.equal(mutation.$inc.appTokens, 0);
  assert.equal(mutation.$inc.reservedAppTokens, 20);
  assert.equal(mutation.$inc.balanceVersion, 1);
  assert.equal(receipt.entries[0].delta, 0);
  assert.equal(receipt.context.reservedTokens, 20);
  assert.equal(notification.reason, "reservation_hold");
  assert.equal(notification.balanceVersion, 5);
  assert.equal(result.availableTokens, 80);
  assert.equal(result.maxTransferTokens, 80);
});

test("delayed notifications carry one coherent latest balance snapshot", async (t) => {
  let count = 0; const events = [];
  t.mock.method(BalanceOutbox, "findOneAndUpdate", () => ({ lean: async () => count++ ? null : {
    _id: "outbox", user: "user", operation: "receipt", balanceVersion: 1, reason: "reservation_hold",
  } }));
  t.mock.method(BalanceOutbox, "updateOne", async () => ({}));
  t.mock.method(ledger, "getBalance", async () => ({ userId: "user", appTokens: -1200,
    reservedAppTokens: 0, availableTokens: -1200, maxTransferTokens: 0, balanceVersion: 3 }));
  const outbox = createOutboxWorker({ bus: { publish: async (event) => events.push(event) } });
  await outbox.drain(); await outbox.stop();
  assert.equal(events.length, 1);
  assert.equal(events[0].balanceVersion, 3);
  assert.equal(events[0].reservedAppTokens, 0);
  assert.equal(events[0].maxTransferTokens, 0);
  assert.equal(events[0].appTokens, -1200);
});
