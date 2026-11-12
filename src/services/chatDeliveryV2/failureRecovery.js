// Recover only a boundary with confirmed usage and no in-flight provider call.
// Never guess costs, replay the model, or turn an unfinished file into a success.
const validUsage = usage => usage && ['promptTokens', 'completionTokens', 'totalTokens']
  .every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0);
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
function partialResult(turn, code) {
  if (turn.providerResult || turn.cancelRequestedAt || turn.computeState?.documentJob?.active ||
      turn.responseState && turn.responseState.pending !== false ||
      turn.computeState && turn.computeState.pending !== false) return null;
  const state = turn.responseState || turn.computeState;
  if (!state || state.pending !== false || !validUsage(state.usage)) return null;
  if (turn.computeState && (!validUsage(turn.computeState.usage) ||
      ['promptTokens', 'completionTokens', 'totalTokens'].some(key => turn.computeState.usage[key] !== state.usage[key]))) return null;
  const reason = safeCode(code) || 'INTERNAL_ERROR';
  if (turn.computeState) return require('../computation/agent').partial(turn, reason);
  const partial = turn.responseState.partialData || {};
  return { ...partial, usage: state.usage,
    assistantText: `${partial.assistantText || ''}${partial.assistantText ? '\n\n' : ''}Generation stopped (${reason}). The task may be incomplete; only completed files are attached.` };
}
function diagnostic(error, turn) {
  const bounded = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/.test(value) ? value : null;
  const number = value => Number.isFinite(value) ? value : null;
  return { version: 1, at: new Date(), code: safeCode(error.fileError || error.protocolError?.code) || 'INTERNAL_ERROR',
    providerHttpStatus: Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : null,
    providerCode: bounded(error.code || error.error?.code), requestId: bounded(error.request_id || error._request_id),
    providerResponseStatus: bounded(error.providerResponse?.status),
    incompleteReason: bounded(error.providerResponse?.incomplete_details?.reason),
    apiMode: bounded(turn.providerConfig?.apiMode), responsePending: turn.responseState?.pending ?? null,
    computePending: turn.computeState?.pending ?? null, calls: number(turn.responseState?.calls ?? turn.computeState?.calls),
    runs: number(turn.computeState?.runs), stage: bounded(turn.computeState?.stage),
    lastActionError: safeCode(turn.computeState?.lastActionError), documentJobActive: turn.computeState?.documentJob?.active === true };
}
module.exports = { validUsage, partialResult, diagnostic };
