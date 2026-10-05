const { User, ChatBillingLedger } = require("../models");
const { calculateModelCost } = require("../utils");

const tokenLedger = require("./tokenLedger");

const NEGATIVE_LIMIT = -1000;

const calculateCost = async ({ modelId, usage }) =>
  calculateModelCost({
    modelId,
    inputTokens: usage.prompt_tokens ?? usage.promptTokens ?? 0,
    outputTokens: usage.completion_tokens ?? usage.completionTokens ?? 0,
  });

// Keep the legacy overdraft behaviour while preserving concurrent balance changes.
const finalizeCharge = async ({ userId, modelId, usage }) => {
  const cost = await calculateCost({ modelId, usage });
  let balance;
  try {
    balance = await tokenLedger.debit({ userId, amount: cost.appTokens, kind: "chat_charge" });
  } catch (error) {
    if (error.code === "BALANCE_UPDATE_REJECTED") throw new Error("User not found");
    throw error;
  }
  return { ...cost, balance: balance.appTokens, balanceVersion: balance.balanceVersion };
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

  let balance;
  try {
    balance = await tokenLedger.debit({ userId, amount: cost.appTokens, minBalance: NEGATIVE_LIMIT,
      kind: "chat_charge", key: `chat:${turnId}`, session });
  } catch (cause) {
    if (cause.code !== "BALANCE_UPDATE_REJECTED") throw cause;
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
      balance: balance.appTokens,
    }],
    { session },
  );

  return {
    ...cost,
    balance: balance.appTokens,
    alreadyApplied: false,
  };
};

module.exports = finalizeCharge;
module.exports.finalizeChargeInTransaction = finalizeChargeInTransaction;
