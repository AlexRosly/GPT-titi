const mongoose = require("mongoose");
const { ChatTurn, ChatModels } = require("../../models");
const { estimateTokens, estimateCost } = require("../../utils");
const { reserve, protocolError } = require("./reservations");
const { APP_TOKEN_VALUE_USD } = require("../../config/billing");

const retryTurn = async ({ turnId, userId }) => {
  const previous = await ChatTurn.findOne({ turnId, user: userId }).lean();
  if (!previous) throw protocolError("TURN_NOT_FOUND");
  if (previous.status !== "failed" || !previous.error?.retryable || previous.needsReconciliation || previous.reservationState === "held") throw protocolError("TURN_NOT_RETRYABLE");
  const ocrModel = await ChatModels.findOne({ modelId: previous.modelId, enabled: true }).lean();
  if (!ocrModel) throw protocolError("MODEL_NOT_AVAILABLE");
  const ocr = require("../files/ocrInput");
  if (ocr.enabled(ocrModel)) await ocr.prepareHistory(userId, await require("../files/textContext").forTurn(previous), ocrModel);
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
      if (turn.webPlan && !require("../web/policy").enabled(model)) throw protocolError("WEB_INPUT_DISABLED");
      const estimate = await estimateCost(turn.modelId, estimateTokens(turn.message));
      const textContext = require("../files/textContext");
      const history = await textContext.forTurn(turn, session);
      const textBudget = await textContext.estimate(userId, history, model, session);
      const exact = require("../files/exactTranscription");
      const exactBytes = !turn.outputFile && exact.potential(history, model) ? exact.reserveBytes : 0;
      const reservedAmount = estimate.appTokens + require("../files/textInput").reserveAmount(textBudget.promptBytes + exactBytes, model.inputPerM, APP_TOKEN_VALUE_USD);
      await reserve({ userId, amount: reservedAmount, turnId, attempt: turn.attempt + 1, session });
      return ChatTurn.findOneAndUpdate({ _id: turn._id, status: "failed", attempt: turn.attempt }, {
        $set: { status: "queued", lastSeq: 0, partialContent: "", error: null, processingStartedAt: null,
          leaseToken: null, leaseUntil: null, reservedAppTokens: reservedAmount, reservationState: "held",
          webBudget: null,
          webState: turn.webState ? { version: 2, results: (turn.webState.results || []).filter(r => r.status === "ready") } : null,
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
