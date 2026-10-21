const mongoose = require('mongoose');
const { ChatTurn, User } = require('../../models');
const ledger = require('../tokenLedger');
const { estimate } = require('../web/budget');
const { protocolError, NEGATIVE_LIMIT, availableExpression } = require('../chatDeliveryV2/reservations');
const guard = (turn, token) => ({ _id: turn._id, user: turn.user, attempt: turn.attempt,
  status: 'processing', leaseToken: token, leaseUntil: { $gt: new Date() }, reservationState: 'held' });
const cost = (usage, pricing) => Math.ceil((usage.promptTokens * pricing.inputPerM + usage.completionTokens * pricing.outputPerM) / 1e6 / pricing.tokenValueUsd);
async function begin(turn, token, messages, tools) {
  const budget = estimate(messages, tools, turn.pricing);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await ChatTurn.findOne(guard(turn, token)).session(session);
      if (!current || current.browserState?.pending) throw Object.assign(new Error('Stale lease'), { staleLease: true });
      const state = current.browserState || { calls: 0, pending: false, usage: { promptTokens:0, completionTokens:0, totalTokens:0 } };
      if (state.calls >= 5) throw protocolError('BROWSER_LIMIT');
      const target = Math.max(current.reservedAppTokens, cost(state.usage, current.pricing) + budget.amount);
      const extra = target - current.reservedAppTokens;
      const user = await User.findById(turn.user).session(session).lean();
      if (!user || user.status !== 'active') throw protocolError('CONVERSATION_NOT_FOUND');
      const available = user.appTokens - (user.reservedAppTokens || 0);
      if (user.appTokens < NEGATIVE_LIMIT) throw protocolError('BALANCE_LIMIT_EXCEEDED');
      if (available < extra) throw protocolError('INSUFFICIENT_BALANCE', { balance: user.appTokens,
        availableTokens: available + current.reservedAppTokens, estimatedTokens: target });
      if (extra) await ledger.increaseWebReservation({ userId:turn.user, amount:extra, turnId:turn.turnId,
        attempt:turn.attempt, phase:state.calls + 1, session,
        filter:{ status:'active', appTokens:{$gte:NEGATIVE_LIMIT}, $expr:{$gte:[availableExpression,extra]} } });
      const next = { ...state, calls:state.calls+1, pending:true };
      const result = await ChatTurn.updateOne(guard(turn,token), {$set:{ reservedAppTokens:target,
        browserState:next, providerStartedAt:new Date() }}, {session});
      if (!result.matchedCount) throw Object.assign(new Error('Stale lease'), {staleLease:true});
      turn.browserState = next;
    });
    ledger.notifyCommitted(); return budget;
  } finally { await session.endSession(); }
}
async function received(turn, token, usage) {
  if (!usage || ![usage.prompt_tokens,usage.completion_tokens,usage.total_tokens].every(n=>Number.isSafeInteger(n)&&n>=0)) throw new Error('Missing provider usage; reconciliation required');
  const old = turn.browserState.usage;
  const next = { ...turn.browserState, pending:false, usage:{ promptTokens:old.promptTokens+usage.prompt_tokens,
    completionTokens:old.completionTokens+usage.completion_tokens, totalTokens:old.totalTokens+usage.total_tokens } };
  const result = await ChatTurn.updateOne({...guard(turn,token), 'browserState.pending':true, 'browserState.calls':next.calls}, {$set:{browserState:next}});
  if (!result.matchedCount) throw Object.assign(new Error('Stale lease'), {staleLease:true});
  turn.browserState = next;
}
async function rejected(turn, token) {
  // A documented pre-generation HTTP rejection adds zero usage; prior calls remain billable.
  return received(turn, token, {prompt_tokens:0,completion_tokens:0,total_tokens:0});
}
module.exports = { guard, begin, received, rejected, cost };
