const { errorFor } = require('./protocol');

const COVER_UNKNOWN = 'platform_covers_unknown';
const policy = () => process.env.CHAT_EARLY_CANCEL_UNKNOWN_USAGE_POLICY === COVER_UNKNOWN ? COVER_UNKNOWN : 'manual';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const validUsage = u => u && ['promptTokens', 'completionTokens', 'totalTokens'].every(k => integer(u[k])) &&
  u.promptTokens + u.completionTokens === u.totalTokens;
const initialCall = turn => turn.providerConfig?.apiMode === 'chat_completions' &&
  !turn.computeState && !turn.responseState && !turn.browserState && !turn.webPlan &&
  !turn.providerResult && !turn.assistantMessage;
const noDeliveredOutput = turn => turn.lastSeq === 0 && turn.partialContent === '';
const canCoverUnknown = turn => Boolean(turn.cancelRequestedAt && turn.providerStartedAt) &&
  initialCall(turn) && noDeliveredOutput(turn) && !turn.initialProviderUsage;
const cancellationError = pending => errorFor('USER_CANCELLED', pending
  ? 'Generation cancelled. Token settlement needs review.'
  : 'Generation cancelled. Token settlement is complete.', false);

// Only final provider-reported usage is accepted, never estimates or output length.
function readInitialUsage(raw) {
  if (!raw) return null;
  const usage = { promptTokens: raw.prompt_tokens, completionTokens: raw.completion_tokens, totalTokens: raw.total_tokens };
  return validUsage(usage) ? usage : null;
}

// Runs inside the transaction that owns/fails the cancelled attempt. Unknown
// provider cost can be absorbed only under an explicit policy, never labelled free.
async function settleInitialCancellation(turn, session, options = {}) {
  if (!session || !turn.cancelRequestedAt || turn.reservationState !== 'held' || !initialCall(turn)) return null;
  const usage = turn.initialProviderUsage;
  const confirmed = validUsage(usage);
  if (!confirmed && (options.policy ?? policy()) !== COVER_UNKNOWN) return null;
  if (!confirmed && !canCoverUnknown(turn)) return null;
  if (confirmed) {
    const p = turn.pricing;
    if (!p || ![p.inputPerM, p.outputPerM].every(n => Number.isFinite(n) && n >= 0) ||
        !Number.isFinite(p.tokenValueUsd) || p.tokenValueUsd <= 0) return null;
  }
  const { ChatBillingLedger, TokenOperation } = require('../../models');
  if (await ChatBillingLedger.exists({ turnId: turn.turnId }).session(session) ||
      await TokenOperation.exists({ key: `chat:${turn.turnId}` }).session(session)) {
    throw Object.assign(new Error('CANCEL_EXISTING_CHARGE'), { code: 'CANCEL_EXISTING_CHARGE' });
  }
  let billed = null;
  if (confirmed) {
    const cost = await require('../finalizeCharge').finalizeChargeInTransaction({ session,
      turnId: turn.turnId, userId: turn.user, conversationId: turn.conversation,
      modelId: turn.modelId, pricing: turn.pricing,
      usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens } });
    if (cost.alreadyApplied) throw new Error('CANCEL_EXISTING_CHARGE');
    billed = { appTokensSpent: cost.appTokens, totalTokens: usage.totalTokens, balance: cost.balance };
  }
  await require('./reservations').release(turn, session, confirmed ? 'settled' : 'released');
  return {
    needsReconciliation: false,
    ...(confirmed ? { usage: { ...usage }, billing: billed, billingAppliedAt: new Date() } : {}),
    error: cancellationError(false),
    reconciliation: {
      source: options.source || 'early-user-cancel-v1', at: new Date(),
      decision: confirmed ? 'confirmed_usage' : COVER_UNKNOWN,
      providerUsageKnown: Boolean(confirmed), platformCoversUnknown: !confirmed,
      usage: confirmed ? { ...usage } : null, userChargeTokens: billed?.appTokensSpent || 0,
      releasedTokens: turn.reservedAppTokens,
      ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
      reason: confirmed ? 'Final usage received before cancellation; no further provider call or tool execution.'
        : 'Explicit platform policy covers unknown cost of early cancellation without delivered output or tool execution.',
    },
  };
}
module.exports = { COVER_UNKNOWN, policy, readInitialUsage, validUsage, initialCall,
  canCoverUnknown, cancellationError, settleInitialCancellation };
