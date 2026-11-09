const test = require('node:test');
const assert = require('node:assert/strict');
process.env.OPENAI_API_KEY ||= 'test-placeholder';
const mongoose = require('mongoose');
const { ChatTurn } = require('../../src/models');
const reservations = require('../../src/services/chatDeliveryV2/reservations');

function fixture(t, status = 'queued') {
  const turn = { _id: 'turn', turnId: 'turn-id', user: 'owner', status, attempt: 1, reservationState: 'held', providerResult: null };
  let releases = 0, aborts = 0;
  t.mock.method(mongoose, 'startSession', async () => ({ withTransaction: async fn => fn(), endSession: async () => {} }));
  t.mock.method(ChatTurn, 'findOne', query => ({ session: async () => query.user === turn.user ? turn : null }));
  t.mock.method(ChatTurn, 'findOneAndUpdate', async (_, update) => { Object.assign(turn, update.$set); return turn; });
  t.mock.method(reservations, 'release', async () => { releases++; turn.reservationState = 'released'; });
  t.mock.method(require('../../src/services/tokenLedger'), 'notifyCommitted', () => {});
  t.mock.method(require('../../src/services/chatDeliveryV2/worker'), 'abortTurn', () => { aborts++; });
  const key = require.resolve('../../src/services/chatDeliveryV2/cancelTurn');
  delete require.cache[key];
  const cancel = require(key);
  t.after(() => delete require.cache[key]);
  return { turn, cancel, releases: () => releases, aborts: () => aborts };
}

test('queued cancellation releases once and repeated delivery is idempotent', async t => {
  const f = fixture(t);
  const result = await f.cancel({ turnId: f.turn.turnId, userId: 'owner' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'USER_CANCELLED');
  await f.cancel({ turnId: f.turn.turnId, userId: 'owner' });
  assert.equal(f.releases(), 1);
});
test('processing cancellation persists a flag and signals the worker without releasing uncertain usage', async t => {
  const f = fixture(t, 'processing');
  await f.cancel({ turnId: f.turn.turnId, userId: 'owner' });
  assert.ok(f.turn.cancelRequestedAt);
  assert.equal(f.turn.status, 'processing');
  assert.equal(f.releases(), 0);
  assert.equal(f.aborts(), 1);
});
test('foreign user cannot cancel another user turn', async t => {
  const f = fixture(t);
  await assert.rejects(f.cancel({ turnId: f.turn.turnId, userId: 'stranger' }), e => e.protocolError.code === 'TURN_NOT_FOUND');
  assert.equal(f.releases(), 0);
  assert.equal(f.aborts(), 0);
});
test('a committed provider result is finalized rather than discarded by a late cancellation', async t => {
  const f = fixture(t, 'processing');
  f.turn.providerResult = { assistantText: 'Durable answer' };
  await f.cancel({ turnId: f.turn.turnId, userId: 'owner' });
  assert.equal(f.turn.cancelRequestedAt, undefined);
  assert.equal(f.aborts(), 0);
});
