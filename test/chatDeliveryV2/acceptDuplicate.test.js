const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const models = require('../../src/models');
const reservations = require('../../src/services/chatDeliveryV2/reservations');
const utils = require('../../src/utils');
const ledger = require('../../src/services/tokenLedger');
const { buildRequestHash } = require('../../src/services/chatDeliveryV2/protocol');

for (const scenario of ['concurrent winner', 'retry after aborted writes', 'conflicting winner']) {
  test(`acceptTurn handles ${scenario} before another reservation`, async (t) => {
    const userId = 'user';
    const payload = { clientMessageId: 'message', conversationId: 'conversation', modelId: 'model', message: 'hello' };
    const winner = { turnId: 'winner', requestHash: buildRequestHash({ userId, ...payload, files: [] }) };
    if (scenario === 'conflicting winner') winner.requestHash = 'different';
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
      const value = index === 0 || (scenario === 'retry after aborted writes' && index === 1) ? null : winner;
      return { session(s) { assert.equal(s, session); return this; }, lean: async () => value };
    });
    t.mock.method(reservations, 'reserve', async () => { reserves++; });
    t.mock.method(utils, 'estimateCost', async () => ({ appTokens: 1 }));
    t.mock.method(models.ChatMessage, 'find', () => ({ sort() { return this; }, limit() { return this; }, session() { return this; }, lean: async () => [] }));
    t.mock.method(models.ChatMessage, 'create', async () => [{ _id: 'discarded-message' }]);
    t.mock.method(models.ChatTurn, 'create', async () => [{ toObject: () => ({ turnId: 'discarded-turn' }) }]);
    t.mock.method(ledger, 'notifyCommitted', () => { notified++; });
    const path = require.resolve('../../src/services/chatDeliveryV2/acceptTurn');
    delete require.cache[path];
    const acceptTurn = require(path);
    t.after(() => { delete require.cache[path]; });
    if (scenario === 'conflicting winner') {
      await assert.rejects(acceptTurn({ userId, payload }), e => e.protocolError.code === 'IDEMPOTENCY_CONFLICT');
    } else {
      const result = await acceptTurn({ userId, payload });
      assert.equal(result.disposition, 'duplicate');
      assert.equal(result.turn.turnId, 'winner');
    }
    assert.equal(reserves, scenario === 'retry after aborted writes' ? 1 : 0);
    assert.equal(notified, 0);
    assert.equal(ended, 1);
  });
}
