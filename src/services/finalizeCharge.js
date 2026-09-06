const mongoose = require("mongoose");
const { User, ChatBillingLedger } = require("../models");
const { calculateModelCost } = require("../utils");

const NEGATIVE_LIMIT = -1000;

const calculateCost = async ({ modelId, usage }) =>
  calculateModelCost({
    modelId,
    inputTokens: usage.prompt_tokens ?? usage.promptTokens ?? 0,
    outputTokens: usage.completion_tokens ?? usage.completionTokens ?? 0,
  });

// Legacy billing path. Existing v1 callers keep their current behaviour.
const finalizeCharge = async ({ userId, modelId, usage }) => {
  const cost = await calculateCost({ modelId, usage });
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  user.appTokens -= cost.appTokens;
  await user.save();
  return { ...cost, balance: user.appTokens };
};

// v2 path: ledger creation and balance mutation must happen in the same Mongo transaction.
const finalizeChargeInTransaction = async ({
  session,
  turnId,
  userId,
  modelId,
  usage,
}) => {
  if (!session || !turnId) throw new Error("session and turnId are required");

  const cost = await calculateCost({ modelId, usage });
  let ledger = await ChatBillingLedger.findOne({ turnId }).session(session);

  if (ledger) {
    const user = await User.findById(userId).session(session).lean();
    if (!user) throw new Error("User not found");
    return {
      ...cost,
      appTokens: ledger.appTokensSpent,
      balance: ledger.balance,
      alreadyApplied: true,
    };
  }

  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      appTokens: { $gte: cost.appTokens + NEGATIVE_LIMIT },
    },
    { $inc: { appTokens: -cost.appTokens } },
    { new: true, session },
  );

  if (!user) {
    const error = new Error("Insufficient balance");
    error.code = "INSUFFICIENT_BALANCE";
    throw error;
  }

  [ledger] = await ChatBillingLedger.create(
    [{
      turnId,
      user: userId,
      modelId,
      appTokensSpent: cost.appTokens,
      totalTokens: usage.total_tokens ?? usage.totalTokens ?? 0,
      usd: cost.usd,
      balance: user.appTokens,
    }],
    { session },
  );

  return {
    ...cost,
    balance: user.appTokens,
    alreadyApplied: false,
  };
};

module.exports = finalizeCharge;
module.exports.finalizeChargeInTransaction = finalizeChargeInTransaction;
