// utils/estimateCost.js
const { ChatModels } = require("../models");
const { APP_TOKEN_VALUE_USD } = require("../config/billing");

const estimateCost = async (modelId, estimatedTokens) => {
  const model = await ChatModels.findOne({
    modelId,
    enabled: true,
  }).lean();

  if (!model) {
    throw new Error(`Model not found or disabled: ${modelId}`);
  }

  // средняя цена (приближение)
  const avgPricePerM = (model.inputPerM + model.outputPerM) / 2;

  const usd = (estimatedTokens / 1_000_000) * avgPricePerM;

  const appTokens = Math.ceil(usd / APP_TOKEN_VALUE_USD);

  return {
    modelId,
    estimatedTokens,
    usd: Number(usd.toFixed(6)),
    appTokens,
  };
};

module.exports = estimateCost;
