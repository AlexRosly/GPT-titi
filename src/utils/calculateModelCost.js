// utils/calculateModelCost.js
const { ChatModels } = require("../models");
const { APP_TOKEN_VALUE_USD } = require("../config/billing");

const calculateModelCost = async ({ modelId, inputTokens, outputTokens }) => {
  const model = await ChatModels.findOne({
    modelId,
    enabled: true,
  }).lean();

  if (!model) {
    throw new Error(`Model not found: ${modelId}`);
  }

  const usd =
    (inputTokens / 1_000_000) * model.inputPerM +
    (outputTokens / 1_000_000) * model.outputPerM;

  const appTokens = Math.ceil(usd / APP_TOKEN_VALUE_USD);

  return {
    modelId,
    inputTokens,
    outputTokens,
    usd: Number(usd.toFixed(6)),
    appTokens,
  };
};

module.exports = calculateModelCost;
