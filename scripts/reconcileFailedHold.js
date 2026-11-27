// Run from the backend root. Every command targets one UUID, attempt, and hold amount.
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const mongoose = require('mongoose');
const { ChatTurn } = require('../src/models');
const { isUuidV4 } = require('../src/services/chatDeliveryV2/protocol');
const hold = require('../src/services/chatDeliveryV2/failedHold');

const options = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };
const fail = reason => { throw new hold.HoldReview(reason); };

async function run({ turnId, attempt, heldTokens }, planToApply) {
  if (!isUuidV4(turnId) || !Number.isSafeInteger(attempt) || attempt < 1 ||
      !Number.isSafeInteger(heldTokens) || heldTokens < 0) fail('INVALID_TARGET');
  const applying = planToApply !== undefined;
  if (applying && (planToApply?.source !== hold.SOURCE || planToApply?.mode !== 'plan' ||
      !planToApply.entry?.fingerprint)) fail('INVALID_PLAN');
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const turn = await ChatTurn.findOne({ turnId, attempt }).session(session).lean();
      if (!turn || turn.reservedAppTokens !== heldTokens) fail('TARGET_OR_AMOUNT_MISMATCH');
      const receipt = turn.reconciliation;
      if (turn.status === 'failed' && ['released', 'settled'].includes(turn.reservationState) &&
          !turn.needsReconciliation && receipt?.source === hold.SOURCE) {
        if (applying && (planToApply.entry.userId !== String(turn.user) ||
            planToApply.entry.fingerprint !== receipt.fingerprint)) fail('STALE_PLAN');
        return { mode: applying ? 'apply' : 'plan', source: hold.SOURCE, turnId, attempt, alreadyApplied: true,
          chargedThisRun: 0, releasedThisRun: 0, receipt, balanceAfter: await hold.balance(turn.user, session) };
      }
      const { entry, before } = await hold.inspect(turn, session);
      if (!applying) return { mode: 'plan', source: hold.SOURCE, alreadyApplied: false, entry, balanceBefore: before,
        projectedReservedTokens: before.reservedAppTokens - heldTokens,
        availableIncrease: heldTokens - entry.userChargeTokens };
      if (!isDeepStrictEqual(entry, planToApply.entry)) fail('STALE_PLAN');
      const closed = await hold.close(turn, entry, session);
      return { mode: 'apply', source: hold.SOURCE, turnId, attempt, alreadyApplied: false,
        chargedThisRun: entry.userChargeTokens, releasedThisRun: entry.heldTokens,
        receipt: closed.reconciliation, balanceAfter: await hold.balance(turn.user, session) };
    }, options);
    if (applying && !result.alreadyApplied) require('../src/services/tokenLedger').notifyCommitted();
    return result;
  } finally { await session.endSession(); }
}

async function main(args) {
  require('dotenv').config({ quiet: true });
  let target, plan;
  if (args.length === 4 && args[0] === '--plan' && /^\d+$/.test(args[2]) && /^\d+$/.test(args[3])) {
    target = { turnId: args[1], attempt: Number(args[2]), heldTokens: Number(args[3]) };
  } else if (args.length === 3 && args[0] === '--apply' && args[2] === '--platform-covers-unknown') {
    if (fs.statSync(args[1]).size > 65536) fail('INVALID_PLAN');
    plan = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    target = plan?.entry;
    if (!target) fail('INVALID_PLAN');
  } else {
    fail('USE --plan TURN_UUID ATTEMPT EXPECTED_HELD_TITI   OR   --apply PLAN.json --platform-covers-unknown');
  }
  const uri = process.env.CHAT_RECONCILIATION_MONGO_URI || process.env.MONGO_URI;
  if (!uri) fail('MISSING_DATABASE_CONFIGURATION');
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  console.log(JSON.stringify(await run(target, plan), null, 2));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: error instanceof hold.HoldReview ? error.message : 'FAILED_HOLD_COMMAND_ERROR',
    details: error instanceof hold.HoldReview ? undefined : error.codeName || error.name }));
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());

module.exports = { run };
