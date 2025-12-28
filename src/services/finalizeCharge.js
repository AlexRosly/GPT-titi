// services/finalizeCharge.js
const { User } = require("../models");
const { calculateModelCost } = require("../utils");

const finalizeCharge = async ({ userId, modelId, usage }) => {
  const cost = await calculateModelCost({
    modelId,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
  });

  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  user.appTokens -= cost.appTokens;
  await user.save();

  return cost;
};

module.exports = finalizeCharge;
