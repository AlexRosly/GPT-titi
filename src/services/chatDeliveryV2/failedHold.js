const { createHash } = require('node:crypto');
const { User, ChatTurn, ChatBillingLedger, TokenOperation } = require('../../models');
const DocumentJob = require('../../models/documentJob');
const { costFromSnapshot, finalizeChargeInTransaction } = require('../finalizeCharge');
const { validUsage, COVER_UNKNOWN, cancellationError } = require('./earlyCancellation');
const { release } = require('./reservations');
const { errorFor } = require('./protocol');

const SOURCE = 'failed-hold-confirmed-usage-v1';
const enabled = () => process.env.CHAT_FAILED_HOLD_POLICY === COVER_UNKNOWN;
const unsigned = n => Number.isSafeInteger(n) && n >= 0;
class HoldReview extends Error {}
function review(code) { throw new HoldReview(code); }
const usageKeys = ['promptTokens', 'completionTokens', 'totalTokens'];
const includesUsage = (aggregate, earlier) => usageKeys.every(k => aggregate[k] >= earlier[k]);

// Each checkpoint is a cumulative total for this attempt. The initial call and
// the Responses/compute mirrors are already included in the later checkpoint.
function confirmedUsage(turn) {
  const { initialProviderUsage: initial, responseState: response, computeState: compute, browserState: browser } = turn;
  if (initial != null && !validUsage(initial)) review('INVALID_INITIAL_USAGE');
  for (const state of [response, compute, browser]) {
    if (state != null && (!validUsage(state.usage) || typeof state.pending !== 'boolean')) review('INVALID_CHECKPOINT');
  }
  if (browser && (response || compute)) review('CONFLICTING_WORKFLOWS');
  let state = browser || response || compute;
  let source = browser ? 'browserState' : response ? 'responseState' : compute ? 'computeState' : null;
  let pending = state?.pending;
  if (response && compute) {
    const equal = usageKeys.every(k => response.usage[k] === compute.usage[k]);
    // accounting.received commits the response to computeState just before
    // responsesTurn copies it to responseState. A crash can split those writes.
    if (!equal) {
      if (response.pending !== true || compute.pending !== false || !includesUsage(compute.usage, response.usage)) {
        review('CONFLICTING_USAGE');
      }
      source = 'computeState';
      state = compute;
      pending = false;
    } else {
      pending = response.pending || compute.pending;
    }
  }
  const usage = state?.usage ?? initial ?? null;
  if (initial && !includesUsage(usage, initial)) review('CONFLICTING_INITIAL_USAGE');
  if (compute?.initialUsage != null &&
      (!validUsage(compute.initialUsage) || !includesUsage(compute.usage, compute.initialUsage))) review('CONFLICTING_INITIAL_USAGE');
  const providerUsageKnown = state ? !pending : initial != null;
  return {
    usage: usage == null ? null : Object.fromEntries(usageKeys.map(k => [k, usage[k]])),
    usageSource: source || (initial ? 'initialProviderUsage' : null),
    providerUsageKnown, platformCoversUnknown: !providerUsageKnown,
  };
}

async function balance(userId, session) {
  const user = await User.findById(userId).select('appTokens reservedAppTokens').session(session).lean();
  if (!user || !Number.isSafeInteger(user.appTokens) || !unsigned(user.reservedAppTokens)) review('INVALID_ACCOUNT_BALANCE');
  return { appTokens: user.appTokens, reservedAppTokens: user.reservedAppTokens,
    availableTokens: user.appTokens - user.reservedAppTokens };
}

// Validate ownership, billing evidence and the hold before the first financial write.
async function inspect(turn, session) {
  if (turn.status !== 'failed' || !turn.needsReconciliation || turn.reservationState !== 'held' ||
      turn.leaseToken || turn.leaseUntil || turn.providerResult || turn.assistantMessage ||
      turn.billing || turn.usage || turn.billingAppliedAt || turn.reconciliation || turn.reservationClosedAt ||
      !unsigned(turn.reservedAppTokens)) review('INELIGIBLE_ATTEMPT');
  if (turn.computeState?.documentJob?.active ||
      await DocumentJob.exists({ turnId: turn.turnId, attempt: turn.attempt,
        $or: [{ status: { $in: ['queued', 'running', 'ready'] } }, { leaseToken: { $ne: null } }] }).session(session)) {
    review('DOCUMENT_JOB_OWNS_TURN');
  }
  const evidence = confirmedUsage(turn);
  let userChargeTokens = 0;
  if (evidence.usage?.totalTokens > 0) {
    const p = turn.pricing;
    if (!p || ![p.inputPerM, p.outputPerM].every(n => Number.isFinite(n) && n >= 0) ||
        !Number.isFinite(p.tokenValueUsd) || p.tokenValueUsd <= 0) review('MISSING_PRICE_SNAPSHOT');
    userChargeTokens = costFromSnapshot(p, evidence.usage).appTokens;
    if (!unsigned(userChargeTokens)) review('INVALID_COST');
  }
  const suffix = turn.turnId + ':' + turn.attempt;
  if (await ChatBillingLedger.exists({ turnId: turn.turnId }).session(session) ||
      await TokenOperation.exists({ $or: [
        { key: { $in: ['chat:' + turn.turnId, 'reservation_release:' + suffix] } },
        { 'entries.user': turn.user, 'context.turnId': turn.turnId, kind: 'chat_charge' },
      ] }).session(session)) review('EXISTING_CHARGE_OR_RELEASE');
  const ops = await TokenOperation.find({ 'entries.user': turn.user, 'context.turnId': turn.turnId,
    'context.attempt': turn.attempt, kind: { $in: ['reservation_hold', 'reservation_release'] } })
    .select('kind key status entries context.reservedTokens').session(session).lean();
  if (!ops.some(op => op.key === 'reservation_hold:' + suffix) ||
      ops.some(op => op.kind !== 'reservation_hold' || op.status !== 'confirmed' || op.entries.length !== 1 ||
        String(op.entries[0].user) !== String(turn.user) || op.entries[0].delta !== 0 || !unsigned(op.context.reservedTokens)) ||
      ops.reduce((sum, op) => sum + op.context.reservedTokens, 0) !== turn.reservedAppTokens) review('HOLD_RECEIPTS_MISMATCH');
  const before = await balance(turn.user, session);
  const [holds] = await ChatTurn.aggregate([
    { $match: { user: turn.user, reservationState: 'held' } },
    { $group: { _id: null, reserved: { $sum: '$reservedAppTokens' } } },
  ]).session(session);
  if (before.reservedAppTokens < turn.reservedAppTokens || holds?.reserved !== before.reservedAppTokens) review('ACCOUNT_HOLDS_MISMATCH');
  const entry = { turnId: turn.turnId, attempt: turn.attempt, userId: String(turn.user), modelId: turn.modelId,
    heldTokens: turn.reservedAppTokens, userChargeTokens, ...evidence };
  entry.fingerprint = createHash('sha256').update(JSON.stringify([SOURCE, entry, turn._id, turn.conversation,
    turn.pricing?.inputPerM, turn.pricing?.outputPerM, turn.pricing?.tokenValueUsd, turn.updatedAt])).digest('hex');
  return { entry, before };
}

async function close(turn, entry, session) {
  const { usage, providerUsageKnown, platformCoversUnknown, userChargeTokens, heldTokens } = entry;
  const charged = usage?.totalTokens > 0;
  const state = charged ? 'settled' : 'released';
  const at = new Date();
  const fields = {};
  if (usage && (charged || providerUsageKnown)) fields.usage = usage;
  if (charged) {
    const cost = await finalizeChargeInTransaction({ session, turnId: turn.turnId, userId: turn.user,
      conversationId: turn.conversation, modelId: turn.modelId, pricing: turn.pricing, usage });
    if (cost.alreadyApplied || cost.appTokens !== userChargeTokens) throw new Error('CHARGE_CHANGED');
    fields.billing = { appTokensSpent: cost.appTokens, totalTokens: usage.totalTokens, balance: cost.balance };
    fields.billingAppliedAt = at;
  }
  await release(turn, session, state);
  const error = turn.cancelRequestedAt ? cancellationError(false) : errorFor('PROCESS_INTERRUPTED',
    'Generation was interrupted. Token settlement is complete. You can send a new request.', false);
  const updated = await ChatTurn.findOneAndUpdate({ _id: turn._id, user: turn.user, attempt: turn.attempt,
    status: 'failed', needsReconciliation: true, reservationState: state, reconciliation: null }, { $set: {
    ...fields, error, needsReconciliation: false, reconciliation: {
      source: SOURCE, at, fingerprint: entry.fingerprint, decision: platformCoversUnknown ? COVER_UNKNOWN : 'confirmed_usage',
      providerUsageKnown, platformCoversUnknown, usage, usageSource: entry.usageSource, userChargeTokens, releasedTokens: heldTokens,
    },
  } }, { new: true, session });
  if (!updated) throw new Error('HOLD_OWNERSHIP_CHANGED');
  return updated;
}

module.exports = { SOURCE, enabled, HoldReview, confirmedUsage, balance, inspect, close };
