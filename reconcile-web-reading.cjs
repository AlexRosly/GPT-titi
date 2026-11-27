// Run from the GPTiti backend root. This operator tool resolves only the pinned failed attempt.
'use strict';
const backend = require('node:module').createRequire(require('node:path').resolve('package.json'));
backend('dotenv').config({ quiet: true });
const mongoose = backend('mongoose');
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
const { User, ChatTurn, ChatBillingLedger, TokenOperation } = backend('./src/models');
const { finalizeChargeInTransaction } = backend('./src/services/finalizeCharge');
const { release } = backend('./src/services/chatDeliveryV2/reservations');
const { errorFor } = backend('./src/services/chatDeliveryV2/protocol');
const target = { turnId: '3ca678b3-a418-4a41-904f-858863fecaee', attempt: 1,
  conversation: '6b080593961c8323264ca5e8', modelId: 'gpt-5.4' };
const hold = 30254;
const source = 'web-reading-confirmed-usage-20261126';
const decision = 'platform_covers_pending_call';
const usage = { prompt_tokens: 37224, completion_tokens: 6265, total_tokens: 43489 };
function check(ok, message) {
  if (!ok) throw new Error(message);
}
async function account(userId, session) {
  const user = await User.findById(userId).select('appTokens reservedAppTokens').session(session).lean();
  check(user, 'Missing account');
  const holds = await ChatTurn.find({ user: userId, reservationState: 'held' })
    .select('turnId attempt status reservedAppTokens needsReconciliation -_id').session(session).lean();
  const held = user.reservedAppTokens || 0;
  return { balanceTiti: user.appTokens, reservedTiti: held, availableTiti: user.appTokens - held,
    unattributedTiti: held - holds.reduce((n, row) => n + row.reservedAppTokens, 0), holds };
}
async function run(mode, session) {
  const turn = await ChatTurn.findOne(target).session(session).lean();
  check(turn, 'Target not found. Check backend directory and database.');
  const before = await account(turn.user, session);
  const filter = { 'context.turnId': target.turnId };
  const ops = await TokenOperation.find(filter).session(session).lean();
  const bill = await ChatBillingLedger.findOne({ turnId: target.turnId }).session(session).lean();
  if (turn.reconciliation?.source === source && turn.reservationState === 'settled' && !turn.needsReconciliation) {
    check(bill && ops.filter(o => o.kind === 'chat_charge').length === 1 &&
      ops.filter(o => o.kind === 'reservation_release').length === 1 &&
      bill.appTokensSpent === turn.reconciliation.userChargeTokens && bill.totalTokens === usage.total_tokens,
      'Previously settled target disagrees with ledger');
    return { alreadyApplied: true, chargedThisRun: 0, releasedThisRun: 0, receipt: turn.reconciliation, account: before };
  }
  const state = turn.browserState;
  check(turn.status === 'failed' && turn.error?.code === 'PROCESS_INTERRUPTED' &&
    turn.needsReconciliation && turn.reservationState === 'held' && turn.reservedAppTokens === hold &&
    !turn.leaseToken && !turn.leaseUntil && !turn.reconciliation && !turn.cancelRequestedAt &&
    !turn.providerResult && !turn.billing && !turn.assistantMessage && !turn.computeState && !turn.responseState &&
    turn.webPlan?.mode === 'browser' && state?.stage === 'reading' && state.pending === true && state.calls === 4 &&
    state.usage?.promptTokens === usage.prompt_tokens && state.usage?.completionTokens === usage.completion_tokens &&
    state.usage?.totalTokens === usage.total_tokens, 'Target state or provider evidence changed. Review a fresh diagnostic.');
  check(!bill && ops.length === 4 && ops.every(o => o.kind === 'reservation_hold' && o.status === 'confirmed' &&
    o.context.attempt === target.attempt && Number.isSafeInteger(o.context.reservedTokens) && o.context.reservedTokens >= 0 &&
    o.entries.length === 1 && String(o.entries[0].user) === String(turn.user) && o.entries[0].delta === 0) &&
    ops.reduce((n, o) => n + o.context.reservedTokens, 0) === hold, 'Target ledger does not match the diagnostic');
  check(before.reservedTiti >= hold && before.unattributedTiti === 0, 'Account holds do not match account balance: ' + JSON.stringify(before));
  const p = turn.pricing;
  check(p && [p.inputPerM, p.outputPerM, p.tokenValueUsd].every(n => Number.isFinite(n) && n > 0), 'Invalid saved tariff');
  const charge = Math.ceil(((usage.prompt_tokens * p.inputPerM + usage.completion_tokens * p.outputPerM) / 1e6) / p.tokenValueUsd);
  check(Number.isSafeInteger(charge) && charge > 0, 'Invalid charge');
  if (mode === '--plan') return { readOnly: true, turnId: turn.turnId, usage, priceSnapshot: p, chargeTiti: charge,
    releaseTiti: hold, projectedReservedTiti: before.reservedTiti - hold, account: before };
  const billed = await finalizeChargeInTransaction({ session, turnId: turn.turnId, userId: turn.user,
    modelId: turn.modelId, conversationId: turn.conversation, pricing: p, usage });
  check(!billed.alreadyApplied && billed.appTokens === charge, 'Unexpected settlement amount');
  await release(turn, session, 'settled');
  const receipt = { source, decision, at: new Date(), providerUsageKnown: false, platformCoversUnknown: true,
    usage, userChargeTokens: charge, releasedTokens: hold };
  const result = await ChatTurn.updateOne({ _id: turn._id, attempt: 1, status: 'failed', reservationState: 'settled', needsReconciliation: true },
    { $set: { needsReconciliation: false, reconciliation: receipt,
      error: errorFor('PROCESS_INTERRUPTED', 'Reading was interrupted. Only confirmed usage was charged.', false) } }, { session });
  check(result.modifiedCount === 1, 'Target changed');
  const after = await account(turn.user, session);
  check(after.balanceTiti === before.balanceTiti - charge && after.reservedTiti === before.reservedTiti - hold &&
    after.unattributedTiti === 0, 'Balance verification failed');
  return { alreadyApplied: false, turnId: turn.turnId, receipt, account: after };
}
async function main() {
  const mode = process.argv[2];
  check(process.argv.length === 3 && ['--plan', '--apply'].includes(mode), 'Use --plan or --apply');
  const uri = process.env.CHAT_RECONCILIATION_MONGO_URI || process.env.MONGO_URI || process.env.MONGODB_URI;
  check(uri, 'Missing backend database configuration');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const session = await mongoose.startSession();
  try {
    const report = await session.withTransaction(() => run(mode, session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    console.log(JSON.stringify(report, null, 2));
  } finally { await session.endSession(); }
}
main().catch(e => { console.error(e.name === 'Error' ? e.message : e.name); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
