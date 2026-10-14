const mongoose = require("mongoose");
const { ChatTurn, ChatModels } = require("../../models");
const { estimateTokens, estimateCost } = require("../../utils");
const { reserve, protocolError } = require("./reservations");
const { APP_TOKEN_VALUE_USD } = require("../../config/billing");

const retryTurn = async ({ turnId, userId }) => {
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const turn = await ChatTurn.findOne({ turnId, user: userId }).session(session).lean();
      if (!turn) throw protocolError("TURN_NOT_FOUND");
      if (turn.status !== "failed" || !turn.error?.retryable || turn.needsReconciliation || turn.reservationState === "held") {
        throw protocolError("TURN_NOT_RETRYABLE");
      }
      const model = await ChatModels.findOne({ modelId: turn.modelId, enabled: true }).session(session).lean();
      if (!model) throw protocolError("MODEL_NOT_AVAILABLE");
      const estimate = await estimateCost(turn.modelId, estimateTokens(turn.message));
      await reserve({ userId, amount: estimate.appTokens, turnId, attempt: turn.attempt + 1, session });
      return ChatTurn.findOneAndUpdate({ _id: turn._id, status: "failed", attempt: turn.attempt }, {
        $set: { status: "queued", lastSeq: 0, partialContent: "", error: null, processingStartedAt: null,
          leaseToken: null, leaseUntil: null, reservedAppTokens: estimate.appTokens, reservationState: "held",
          reservationClosedAt: null, providerStartedAt: null, providerResult: null, needsReconciliation: false,
          pricing: { inputPerM: model.inputPerM, outputPerM: model.outputPerM, tokenValueUsd: APP_TOKEN_VALUE_USD } },
        $inc: { attempt: 1 },
      }, { new: true, session });
    });
    require("../tokenLedger").notifyCommitted();
    return result;
  } finally { await session.endSession(); }
};
module.exports = retryTurn;
