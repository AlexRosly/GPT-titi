// Shared single-action executor. Both provider protocols use the same sandbox,
// ownership checks, budgets, quotas and transactional file checkpoints.
const { ChatTurn } = require('../../models');
const policy = require('./policy');
const accounting = require('./accounting');
const fileIO = require('./files');
const store = require('../files/store');

async function run({ turn, token, model, call, available, transcript, initialUsage, save, signal }) {
  signal?.throwIfAborted();
  const l = policy.limits();
  const action = policy.parse(call.function.arguments), state = turn.computeState;
  if (state.runs >= l.runs || state.executionMs >= l.totalMs) throw policy.fail('COMPUTE_RUN_LIMIT');
  if (action.exports.length && !require('../files/artifacts').outputEnabled(model)) throw policy.fail('COMPUTE_OUTPUT_DISABLED');
  const preview = require('./budget').estimate(transcript, [policy.tool], turn.pricing);
  const extra = accounting.cost({ promptTokens: state.usage.promptTokens - initialUsage.promptTokens,
    completionTokens: state.usage.completionTokens - initialUsage.completionTokens }, turn.pricing) * turn.pricing.tokenValueUsd;
  if (extra + preview.usd > l.usd) {
    require('./budget').diagnoseRejection(turn, 'before_python', preview, extra, l.usd);
    throw policy.fail('COMPUTE_BUDGET_LIMIT');
  }
  const inputs = await fileIO.inputs(turn, action, available);
  const started = Date.now();
  await save({ ...state, runs: state.runs + 1, stage: 'executing' });
  let result, prepared = [];
  try {
    result = await require('./session').run({ code: action.code, files: inputs, exports: action.exports,
      timeoutMs: Math.min(l.runMs, l.totalMs - state.executionMs) }, signal);
    prepared = await fileIO.outputs(result, action, model);
  } catch (error) {
    if (error.cleanupUnconfirmed) throw error;
    if (signal?.aborted) throw policy.fail('COMPUTE_ABORTED');
    result = { ok: false, text: error.fileError || 'COMPUTE_EXECUTION_FAILED', exports: [], truncated: false };
  }
  const next = { ...turn.computeState, executionMs: state.executionMs + Date.now() - started, stage: 'computed' };
  await store.transaction(async session => {
    const current = await ChatTurn.findOne(accounting.guard(turn, token)).session(session);
    if (!current) throw Object.assign(Error('Stale lease'), { staleLease: true });
    const replacements = new Set(prepared.map(f => f.name.normalize('NFC').toLowerCase()));
    const previous = current.computeState.files || [];
    const refs = previous.filter(f => !replacements.has(f.name.normalize('NFC').toLowerCase()));
    if (refs.length + prepared.length > l.files || refs.reduce((n, f) => n + f.size, 0) + prepared.reduce((n, f) => n + f.buffer.length, 0) > l.outputBytes) throw policy.fail('COMPUTE_OUTPUT_LIMIT');
    for (const old of previous) if (replacements.has(old.name.normalize('NFC').toLowerCase())) await store.removeTemporary(turn.user, old.fileId, session);
    for (let i = 0; i < prepared.length; i++) {
      const f = prepared[i];
      const stored = await store.create({ ...f, user: turn.user, source: 'generated', retention: 'temporary',
        resultKey: `${turn.turnId}:${turn.attempt}:compute:${next.runs}:${i}`, session });
      refs.push({ fileId: String(stored._id), name: stored.originalName, size: stored.size });
    }
    next.files = refs;
    const update = await ChatTurn.updateOne(accounting.guard(turn, token), { $set: { computeState: next } }, { session });
    if (!update.matchedCount) throw Object.assign(Error('Stale lease'), { staleLease: true });
  });
  turn.computeState = next;
  return { result, next };
}

module.exports = { run };
