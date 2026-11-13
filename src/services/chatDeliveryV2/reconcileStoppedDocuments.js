// Operator-only repair of the old document handoff race. No model invocation,
// scheduler, endpoint or automatic waiver of unconfirmed provider charges.
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { User, ChatTurn, ChatBillingLedger, TokenOperation } = require('../../models');
const Job = require('../../models/documentJob');
const Chunk = require('../../models/documentJobChunk');
const { finalizeChargeInTransaction } = require('../finalizeCharge');
const { release } = require('./reservations');
const { errorFor } = require('./protocol');
const SOURCE = 'stopped-document-confirmed-usage-v1';
const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };
const fail = code => { throw Object.assign(new Error(code), { code }); };
const id = value => String(value || '');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const validUsage = u => u && ['promptTokens', 'completionTokens', 'totalTokens'].every(k => integer(u[k])) &&
  u.totalTokens > 0 && u.promptTokens + u.completionTokens === u.totalTokens;
const sameUsage = (a, b) => validUsage(a) && validUsage(b) &&
  ['promptTokens', 'completionTokens', 'totalTokens'].every(k => a[k] === b[k]);
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function targets(input) {
  if (!Array.isArray(input) || !input.length || input.length > 20) fail('REPAIR_INVALID_TARGETS');
  const seen = new Set();
  return input.map(t => {
    if (!t || typeof t.turnId !== 'string' || !/^[a-f0-9-]{36}$/i.test(t.turnId) ||
        !Number.isSafeInteger(t.attempt) || t.attempt < 1 || seen.has(t.turnId)) fail('REPAIR_INVALID_TARGETS');
    seen.add(t.turnId);
    return { turnId: t.turnId, attempt: t.attempt };
  });
}
const balance = user => ({ appTokens: user.appTokens, reservedAppTokens: user.reservedAppTokens || 0,
  availableTokens: user.appTokens - (user.reservedAppTokens || 0), balanceVersion: user.balanceVersion || 0 });

async function inspect(target, session) {
  const turn = await ChatTurn.findOne(target).session(session).lean();
  const state = turn?.computeState;
  if (!turn || turn.status !== 'failed' || turn.error?.code !== 'PROCESS_INTERRUPTED' ||
      turn.needsReconciliation !== true || turn.reservationState !== 'held' ||
      turn.providerResult || turn.leaseToken || turn.cancelRequestedAt || turn.reconciliation ||
      !integer(turn.reservedAppTokens) || turn.reservedAppTokens === 0 ||
      state?.kind !== 'document' || state.stage !== 'executing' || state.pending !== false ||
      state.documentJob?.active !== true || !validUsage(state.usage) ||
      (turn.responseState && (turn.responseState.pending !== false || !sameUsage(turn.responseState.usage, state.usage)))) {
    fail('REPAIR_UNSAFE_TURN');
  }
  const job = await Job.findOne({ turnId: turn.turnId, attempt: turn.attempt }).session(session).lean();
  if (!job || id(job._id) !== state.documentJob.id || id(job.turn) !== id(turn._id) || id(job.user) !== id(turn.user) ||
      job.status !== 'cancelled' || job.errorCode !== 'DOCUMENT_TURN_GONE' || !job.finishedAt ||
      job.leaseToken || job.leaseUntil || job.resultFile || job.cursor !== 0 || job.chunks !== 0 || job.stagedBytes !== 0 ||
      await Chunk.exists({ job: job._id }).session(session)) fail('REPAIR_UNSAFE_JOB');
  const p = turn.pricing;
  if (!p || ![p.inputPerM, p.outputPerM, p.tokenValueUsd].every(n => Number.isFinite(n) && n >= 0) ||
      p.tokenValueUsd <= 0) fail('REPAIR_MISSING_PRICE_SNAPSHOT');
  // A pre-existing debit must be investigated, never silently charged again or
  // compared only to a historical reserve amount.
  if (await ChatBillingLedger.exists({ turnId: turn.turnId }).session(session) ||
      await TokenOperation.exists({ key: `chat:${turn.turnId}` }).session(session)) fail('REPAIR_EXISTING_CHARGE');
  const ops = await TokenOperation.find({ 'context.turnId': turn.turnId, 'context.attempt': turn.attempt,
    kind: { $in: ['reservation_hold', 'reservation_release'] } }).session(session).lean();
  if (!ops.length || ops.some(o => o.status !== 'confirmed' || o.kind !== 'reservation_hold' ||
      !integer(o.context?.reservedTokens) || o.entries.length !== 1 || id(o.entries[0].user) !== id(turn.user) || o.entries[0].delta !== 0) ||
      ops.reduce((sum, o) => sum + o.context.reservedTokens, 0) !== turn.reservedAppTokens) fail('REPAIR_RESERVATION_MISMATCH');
  const usage = { prompt_tokens: state.usage.promptTokens, completion_tokens: state.usage.completionTokens,
    total_tokens: state.usage.totalTokens };
  const rawUsd = (usage.prompt_tokens * p.inputPerM + usage.completion_tokens * p.outputPerM) / 1_000_000;
  const chargeTokens = Math.ceil(rawUsd / p.tokenValueUsd);
  if (!integer(chargeTokens) || !Number.isFinite(rawUsd)) fail('REPAIR_INVALID_COST');
  const row = { ...target, jobId: id(job._id), reservedTokens: turn.reservedAppTokens,
    usage, chargeTokens, costUsd: Number(rawUsd.toFixed(6)) };
  row.fingerprint = fingerprint({ row, user: id(turn.user), conversation: id(turn.conversation), model: turn.modelId,
    pricing: { inputPerM: p.inputPerM, outputPerM: p.outputPerM, tokenValueUsd: p.tokenValueUsd },
    turnUpdatedAt: turn.updatedAt, jobUpdatedAt: job.updatedAt, jobFinishedAt: job.finishedAt });
  return { turn, row };
}

async function plan(input) {
  const selected = targets(input), session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const entries = []; let userId;
      for (const target of selected) {
        const { turn, row } = await inspect(target, session);
        if (userId && userId !== id(turn.user)) fail('REPAIR_MIXED_ACCOUNTS');
        userId = id(turn.user); entries.push(row);
      }
      const user = await User.findById(userId).session(session).lean();
      const releaseTokens = entries.reduce((n, e) => n + e.reservedTokens, 0);
      const chargeTokens = entries.reduce((n, e) => n + e.chargeTokens, 0);
      if (!user || !integer(releaseTokens) || !integer(chargeTokens) ||
          user.reservedAppTokens < releaseTokens) fail('REPAIR_ACCOUNT_MISMATCH');
      return { version: 1, source: SOURCE, readOnly: true, generatedAt: new Date().toISOString(), userId,
        entries, totals: { releaseTokens, chargeTokens, availableIncrease: releaseTokens - chargeTokens },
        balanceBefore: balance(user),
        projectedBalance: { appTokens: user.appTokens - chargeTokens,
          reservedAppTokens: user.reservedAppTokens - releaseTokens,
          availableTokens: user.appTokens - chargeTokens - user.reservedAppTokens + releaseTokens } };
    }, transactionOptions);
  } finally { await session.endSession(); }
}

async function apply(planData) {
  if (planData?.version !== 1 || planData.source !== SOURCE || !/^[a-f0-9]{24}$/i.test(planData.userId || '')) fail('REPAIR_INVALID_PLAN');
  const selected = targets(planData.entries), session = await mongoose.startSession();
  let result;
  try {
    result = await session.withTransaction(async () => {
      let releasedTokens = 0, chargedTokens = 0; const entries = [];
      for (let i = 0; i < selected.length; i++) {
        const target = selected[i], expected = planData.entries[i];
        const existing = await ChatTurn.findOne(target).session(session).lean();
        if (id(existing?.user) !== planData.userId) fail('REPAIR_ACCOUNT_MISMATCH');
        if (existing.reconciliation?.source === SOURCE && existing.reconciliation.fingerprint === expected.fingerprint &&
            existing.reservationState === 'settled' && existing.needsReconciliation === false) {
          entries.push({ ...target, alreadyApplied: true }); continue;
        }
        const { turn, row } = await inspect(target, session);
        if (Object.keys(row).some(k => JSON.stringify(row[k]) !== JSON.stringify(expected[k]))) fail('REPAIR_PLAN_STALE');
        const charged = await finalizeChargeInTransaction({ session, turnId: turn.turnId, userId: turn.user,
          modelId: turn.modelId, conversationId: turn.conversation, pricing: turn.pricing, usage: row.usage });
        if (charged.alreadyApplied || charged.appTokens !== row.chargeTokens) fail('REPAIR_CHARGE_MISMATCH');
        await release(turn, session, 'settled');
        const updated = await ChatTurn.updateOne({ _id: turn._id, attempt: turn.attempt, status: 'failed',
          needsReconciliation: true, reservationState: 'settled' }, { $set: {
          needsReconciliation: false, 'computeState.documentJob.active': false, 'computeState.documentJob.state': 'stopped',
          usage: turn.computeState.usage,
          billing: { appTokensSpent: charged.appTokens, totalTokens: row.usage.total_tokens, balance: charged.balance },
          billingAppliedAt: new Date(),
          reconciliation: { source: SOURCE, fingerprint: row.fingerprint, at: new Date(), usage: row.usage,
            reason: 'Confirmed aggregate usage before local document handoff; job cancelled before first chunk.',
            noCharge: false, jobId: row.jobId, releasedTokens: row.reservedTokens },
          error: errorFor('PROCESS_INTERRUPTED', 'Document processing was interrupted. Confirmed model usage has been charged and the reservation released. Please send a new request.', false),
        } }, { session });
        if (updated.modifiedCount !== 1) fail('REPAIR_OWNERSHIP_CHANGED');
        releasedTokens += row.reservedTokens; chargedTokens += charged.appTokens;
        entries.push({ ...target, alreadyApplied: false, releasedTokens: row.reservedTokens, chargedTokens: charged.appTokens });
      }
      const user = await User.findById(planData.userId).session(session).lean();
      if (!user) fail('REPAIR_ACCOUNT_MISMATCH');
      return { version: 1, source: SOURCE, readOnly: false, entries, releasedTokens, chargedTokens, balanceAfter: balance(user) };
    }, transactionOptions);
  } finally { await session.endSession(); }
  // Durable outbox rows commit with the charge and release. The running backend
  // also drains them, even though this operator process exits after the repair.
  require('../tokenLedger').notifyCommitted();
  return result;
}
module.exports = { plan, apply };
