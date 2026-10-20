const mongoose = require("mongoose");
const { ChatTurn } = require("../../models");
const { finalizeChargeInTransaction } = require("../finalizeCharge");
const { release } = require("./reservations");
const { errorFor } = require("./protocol");

// Operator-only boundary; never mount this as a user endpoint. Evidence from the
// provider is required before resolving an ambiguous, potentially billable call.
module.exports = async ({ turnId, attempt, noCharge, usage, reason }) => {
  if (!reason?.trim() || !Number.isSafeInteger(attempt) || attempt < 1 ||
      (noCharge === true) === Boolean(usage)) throw new Error("Provide reason, attempt and exactly one of noCharge/usage");
  if (usage && ![usage.prompt_tokens, usage.completion_tokens, usage.total_tokens]
    .every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid provider usage");
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const turn = await ChatTurn.findOne({ turnId, attempt, status: "failed", needsReconciliation: true }).session(session);
      if (!turn) throw new Error("No unresolved failed attempt matches");
      // For web turns, supplied usage concerns the unresolved provider call.
      // Previously checkpointed selection usage must also be settled exactly once.
      const known = turn.webState?.usage;
      const chargedUsage = known?.totalTokens > 0 ? {
        prompt_tokens: known.promptTokens + (usage?.prompt_tokens || 0),
        completion_tokens: known.completionTokens + (usage?.completion_tokens || 0),
        total_tokens: known.totalTokens + (usage?.total_tokens || 0),
      } : usage;
      if (chargedUsage) await finalizeChargeInTransaction({ session, turnId, userId: turn.user, modelId: turn.modelId,
        conversationId: turn.conversation, pricing: turn.pricing, usage: chargedUsage });
      await release(turn, session, chargedUsage ? "settled" : "released");
      await ChatTurn.updateOne({ _id: turn._id, attempt }, { $set: {
        needsReconciliation: false,
        reconciliation: { reason, at: new Date(), noCharge: !chargedUsage, usage: chargedUsage || null },
        error: errorFor("PROCESS_INTERRUPTED", chargedUsage
          ? "Generation was interrupted. Its provider usage has been charged. Please send a new request."
          : "Generation was interrupted without a charge. You can retry.", !chargedUsage),
      } }, { session });
      return { turnId, attempt, charged: Boolean(chargedUsage) };
    });
  } finally { await session.endSession(); require("../tokenLedger").notifyCommitted(); }
};
