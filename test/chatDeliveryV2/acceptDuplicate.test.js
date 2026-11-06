const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const models = require('../../src/models');
const reservations = require('../../src/services/chatDeliveryV2/reservations');
const utils = require('../../src/utils');
const ledger = require('../../src/services/tokenLedger');
const { buildRequestHash } = require('../../src/services/chatDeliveryV2/protocol');

for (const scenario of ['concurrent winner', 'retry after aborted writes', 'conflicting winner', 'new accepted turn']) {
  test(`acceptTurn handles ${scenario} before another reservation`, async (t) => {
    const userId = 'user';
    const payload = { clientMessageId: 'message', conversationId: 'conversation', modelId: 'model', message: 'hello' };
    const winner = { turnId: 'winner', requestHash: buildRequestHash({ userId, ...payload, files: [] }) };
    if (scenario === 'conflicting winner') winner.requestHash = 'different';
    const createdAt = new Date("2026-11-06T12:00:00Z");
    let activityWrites = 0;
    let reads = 0; let reserves = 0; let ended = 0; let notified = 0;
    const query = (value) => ({ select() { return this; }, lean: async () => value });
    t.mock.method(models.User, 'findById', () => query({ status: 'active' }));
    t.mock.method(models.ChatConversation, 'findOne', () => query({ _id: 'conversation' }));
    t.mock.method(models.ChatModels, 'findOne', () => query({ inputPerM: 1, outputPerM: 1 }));
    const session = {
      endSession: async () => { ended++; },
      withTransaction: async (callback) => {
        if (scenario === 'retry after aborted writes') await callback(); // discarded attempt
        return callback();
      },
    };
    t.mock.method(mongoose, 'startSession', async () => session);
    t.mock.method(models.ChatTurn, 'findOne', () => {
      const index = reads++;
      const value = scenario === 'new accepted turn' || index === 0 || (scenario === 'retry after aborted writes' && index === 1) ? null : winner;
      return { session(s) { assert.equal(s, session); return this; }, lean: async () => value };
    });
    t.mock.method(reservations, 'reserve', async () => { reserves++; });
    t.mock.method(utils, 'estimateCost', async () => ({ appTokens: 1 }));
    t.mock.method(models.ChatMessage, 'find', () => ({ sort() { return this; }, limit() { return this; }, session() { return this; }, lean: async () => [] }));
    t.mock.method(models.ChatMessage, 'create', async () => [{ _id: 'discarded-message' }]);
    t.mock.method(models.ChatTurn, 'create', async () => [{ createdAt, toObject: () => ({ turnId: 'created-turn', createdAt }) }]);
    t.mock.method(models.ChatConversation, 'updateOne', async (filter, update, options) => {
      activityWrites++;
      assert.deepEqual(filter, { _id: payload.conversationId, user: userId, archived: false });
      assert.deepEqual(update, { $max: { lastRequestAt: createdAt } });
      assert.equal(options.session, session);
      assert.equal(options.timestamps, false);
      return { matchedCount: 1 };
    });
    t.mock.method(ledger, 'notifyCommitted', () => { notified++; });
    const path = require.resolve('../../src/services/chatDeliveryV2/acceptTurn');
    delete require.cache[path];
    const acceptTurn = require(path);
    t.after(() => { delete require.cache[path]; });
    if (scenario === 'conflicting winner') {
      await assert.rejects(acceptTurn({ userId, payload }), e => e.protocolError.code === 'IDEMPOTENCY_CONFLICT');
    } else {
      const result = await acceptTurn({ userId, payload });
      assert.equal(result.disposition, scenario === 'new accepted turn' ? 'accepted' : 'duplicate');
      assert.equal(result.turn.turnId, scenario === 'new accepted turn' ? 'created-turn' : 'winner');
    }
    const attempts = ['retry after aborted writes', 'new accepted turn'].includes(scenario) ? 1 : 0;
    assert.equal(reserves, attempts);
    assert.equal(activityWrites, attempts);
    assert.equal(notified, scenario === 'new accepted turn' ? 1 : 0);
    assert.equal(ended, 1);
  });
}
