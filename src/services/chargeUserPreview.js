const { User } = require("../models");
const estimateCost = require("../utils");
const previewLedger = require("./previewLedger");

const PREVIEW_STEP_TOKENS = 300; // шаг проверки

const chargeUserPreview = async (userId, modelId, estimatedTokens) => {
  // проверяем только каждые N токенов
  if (estimatedTokens % PREVIEW_STEP_TOKENS !== 0) {
    return true;
  }

  const estimate = await estimateCost(modelId, estimatedTokens);

  const reserved = previewLedger.get(userId, modelId);

  // если резерв не вырос — ничего не делаем
  if (estimate.appTokens <= reserved) {
    return true;
  }

  const user = await User.findById(userId).lean();
  if (!user) return false;

  const available = user.appTokens - reserved;

  if (available < estimate.appTokens - reserved) {
    return false;
  }

  // резервируем разницу
  previewLedger.set(userId, modelId, estimate.appTokens);

  return true;
};

module.exports = chargeUserPreview;
