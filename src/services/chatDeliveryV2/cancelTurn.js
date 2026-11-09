const mongoose = require('mongoose');
const { ChatTurn } = require('../../models');
const { release, protocolError } = require('./reservations');
const { errorFor } = require('./protocol');

async function cancelTurn({ turnId, userId }) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const turn = await ChatTurn.findOne({ turnId, user: userId }).session(session);
      if (!turn) throw protocolError('TURN_NOT_FOUND');
      if (!['queued', 'processing'].includes(turn.status) || turn.providerResult) { result = turn; return; }
      const values = { cancelRequestedAt: turn.cancelRequestedAt || new Date() };
      if (turn.status === 'queued') {
        await release(turn, session);
        Object.assign(values, { status: 'failed', error: errorFor('USER_CANCELLED'), leaseToken: null, leaseUntil: null });
      }
      result = await ChatTurn.findOneAndUpdate({ _id: turn._id, user: userId, status: turn.status,
        attempt: turn.attempt, providerResult: null }, { $set: values }, { new: true, session });
      if (!result) throw protocolError('TURN_ALREADY_PROCESSING');
    });
  } finally { await session.endSession(); }
  require('../tokenLedger').notifyCommitted();
  // Other worker processes observe the persisted flag at their next heartbeat.
  if (result?.cancelRequestedAt) require('./worker').abortTurn(turnId);
  return result;
}
module.exports = cancelTurn;
