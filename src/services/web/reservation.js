const mongoose = require('mongoose');
const { ChatTurn, User } = require('../../models');
const ledger = require('../tokenLedger');
const { protocolError, NEGATIVE_LIMIT, availableExpression } = require('../chatDeliveryV2/reservations');
const { lease } = require('./context');
const { estimate } = require('./budget');
// Reserve only the additional amount, and mark the provider boundary in the
// SAME transaction. A recovered worker cannot reserve or launch twice.
async function startProvider(turn, leaseToken, messages, tools) {
  const budget = estimate(messages, tools, turn.pricing);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await ChatTurn.findOne(lease(turn, leaseToken)).session(session);
      if (!current) throw Object.assign(new Error('Stale worker lease'), { staleLease: true });
      const target = Math.max(current.reservedAppTokens, budget.amount);
      const extra = target - current.reservedAppTokens;
      const user = await User.findById(turn.user).session(session).lean();
      if (!user || user.status !== 'active') throw protocolError('CONVERSATION_NOT_FOUND');
      const available = user.appTokens - (user.reservedAppTokens || 0);
      const details = { balance: user.appTokens, availableTokens: available + current.reservedAppTokens, estimatedTokens: target };
      if (user.appTokens < NEGATIVE_LIMIT) throw protocolError('BALANCE_LIMIT_EXCEEDED', details);
      if (available < extra) throw protocolError('INSUFFICIENT_BALANCE', details);
      if (extra) await ledger.increaseWebReservation({ userId: turn.user, amount: extra,
        turnId: turn.turnId, attempt: turn.attempt, session,
        filter: { status: 'active', appTokens: { $gte: NEGATIVE_LIMIT }, $expr: { $gte: [availableExpression, extra] } } });
      const result = await ChatTurn.updateOne(lease(turn, leaseToken), { $set: {
        reservedAppTokens: target, webBudget: budget, providerStartedAt: new Date()
      } }, { session });
      if (!result.matchedCount) throw Object.assign(new Error('Stale worker lease'), { staleLease: true });
    });
    ledger.notifyCommitted();
    console.info("WEB_V2_PREPARED", { turnId: turn.turnId, attempt: turn.attempt,
      modelId: turn.modelId, pages: turn.webState?.results?.length || 0,
      estimatedPromptTokens: budget.promptTokens, maxCompletionTokens: budget.outputTokens,
      estimatedAppTokens: budget.amount });
    return budget;
  } finally { await session.endSession(); }
}
module.exports = { startProvider };
