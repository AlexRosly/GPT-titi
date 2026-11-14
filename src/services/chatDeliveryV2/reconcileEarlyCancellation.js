// Operator-only, explicit single-attempt plan; never an account-wide balance reset.
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { User, ChatTurn, ChatBillingLedger, TokenOperation } = require('../../models');
const Job = require('../../models/documentJob');
const early = require('./earlyCancellation');
const SOURCE = 'early-user-cancel-operator-v1';
const txOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };
const fail = code => { throw Object.assign(new Error(code), { code }); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const balance = user => ({ appTokens: user.appTokens, reservedAppTokens: user.reservedAppTokens || 0,
  availableTokens: user.appTokens - (user.reservedAppTokens || 0) });
function target(value) {
  if (!value || typeof value.turnId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.turnId) ||
      !Number.isSafeInteger(value.attempt) || value.attempt < 1) fail('CANCEL_INVALID_TARGET');
  return { turnId: value.turnId, attempt: value.attempt };
}
async function inspect(input, session) {
  const turn = await ChatTurn.findOne(target(input)).session(session).lean();
  if (!turn || turn.status !== 'failed' || turn.needsReconciliation !== true || turn.reservationState !== 'held' ||
      turn.leaseToken || turn.leaseUntil || turn.reconciliation || !early.canCoverUnknown(turn) ||
      !['PROCESS_INTERRUPTED', 'USER_CANCELLED'].includes(turn.error?.code) ||
      turn.failureDiagnostic?.terminal?.code !== 'USER_CANCELLED' ||
      !integer(turn.reservedAppTokens) || turn.reservedAppTokens === 0) fail('CANCEL_UNSAFE_TURN');
  if (await Job.exists({ turnId: turn.turnId, attempt: turn.attempt }).session(session)) fail('CANCEL_HAS_DOCUMENT_JOB');
  if (await ChatBillingLedger.exists({ turnId: turn.turnId }).session(session) ||
      await TokenOperation.exists({ key: `chat:${turn.turnId}` }).session(session)) fail('CANCEL_EXISTING_CHARGE');
  const ops = await TokenOperation.find({ 'context.turnId': turn.turnId, 'context.attempt': turn.attempt,
    kind: { $in: ['reservation_hold', 'reservation_release'] } }).session(session).lean();
  if (!ops.length || ops.some(o => o.kind !== 'reservation_hold' || o.status !== 'confirmed' ||
      !integer(o.context?.reservedTokens) || o.entries.length !== 1 ||
      String(o.entries[0].user) !== String(turn.user) || o.entries[0].delta !== 0) ||
      ops.reduce((n, o) => n + o.context.reservedTokens, 0) !== turn.reservedAppTokens) fail('CANCEL_HOLD_MISMATCH');
  const row = { ...target(turn), userId: String(turn.user), releaseTokens: turn.reservedAppTokens,
    userChargeTokens: 0, providerUsageKnown: false, decision: early.COVER_UNKNOWN };
  row.fingerprint = crypto.createHash('sha256').update(JSON.stringify({ row, updatedAt: turn.updatedAt,
    cancelRequestedAt: turn.cancelRequestedAt, providerStartedAt: turn.providerStartedAt,
    conversation: turn.conversation, modelId: turn.modelId })).digest('hex');
  return { turn, row };
}
async function plan(input) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const { turn, row } = await inspect(input, session);
      const user = await User.findById(turn.user).session(session).lean();
      if (!user || !integer(user.reservedAppTokens) || user.reservedAppTokens < row.releaseTokens) fail('CANCEL_HOLD_MISMATCH');
      const before = balance(user);
      return { version: 1, source: SOURCE, readOnly: true, entry: row, balanceBefore: before,
        projectedBalance: { ...before, reservedAppTokens: before.reservedAppTokens - row.releaseTokens,
          availableTokens: before.availableTokens + row.releaseTokens } };
    }, txOptions);
  } finally { await session.endSession(); }
}
async function apply(input, { platformCoversUnknown = false } = {}) {
  if (platformCoversUnknown !== true) fail('CANCEL_POLICY_ACK_REQUIRED');
  if (input?.version !== 1 || input.source !== SOURCE || input.entry?.decision !== early.COVER_UNKNOWN ||
      !/^[a-f0-9]{24}$/i.test(input.entry?.userId || '')) fail('CANCEL_INVALID_PLAN');
  const selected = target(input.entry), session = await mongoose.startSession();
  let result;
  try {
    result = await session.withTransaction(async () => {
      const existing = await ChatTurn.findOne(selected).session(session).lean();
      if (String(existing?.user) !== input.entry.userId) fail('CANCEL_ACCOUNT_MISMATCH');
      const user = await User.findById(existing.user).session(session).lean();
      if (!user) fail('CANCEL_ACCOUNT_MISMATCH');
      if (existing.reconciliation?.source === SOURCE && existing.reconciliation.fingerprint === input.entry.fingerprint &&
          existing.reservationState === 'released' && existing.needsReconciliation === false) {
        return { alreadyApplied: true, releasedTokens: 0, userChargeTokens: 0, balanceAfter: balance(user) };
      }
      const { turn, row } = await inspect(selected, session);
      if (Object.keys(row).some(k => row[k] !== input.entry[k])) fail('CANCEL_PLAN_STALE');
      const values = await early.settleInitialCancellation(turn, session,
        { policy: early.COVER_UNKNOWN, source: SOURCE, fingerprint: row.fingerprint });
      if (!values || values.reconciliation.providerUsageKnown) fail('CANCEL_PLAN_STALE');
      const updated = await ChatTurn.updateOne({ _id: turn._id, attempt: turn.attempt, status: 'failed',
        needsReconciliation: true, reservationState: 'released' }, { $set: values }, { session });
      if (updated.modifiedCount !== 1) fail('CANCEL_OWNERSHIP_CHANGED');
      const after = await User.findById(turn.user).session(session).lean();
      return { alreadyApplied: false, releasedTokens: row.releaseTokens, userChargeTokens: 0,
        providerUsageKnown: false, decision: early.COVER_UNKNOWN, balanceAfter: balance(after) };
    }, txOptions);
  } finally { await session.endSession(); }
  require('../tokenLedger').notifyCommitted();
  return result;
}
module.exports = { plan, apply };
