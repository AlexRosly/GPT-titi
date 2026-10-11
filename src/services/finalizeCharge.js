const mongoose = require("mongoose");
const { User, ChatBillingLedger, ChatMessage, ChatConversation } = require("../models");
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
const chargeContext = async ({ userId, modelId, usage, conversationId, messageId, turnId, session }) => {
  const conversation = conversationId
    ? await ChatConversation.findOne({ _id: conversationId, user: userId }).select("title").session(session || null).lean()
    : null;
  return {
    modelId, conversationId, conversationTitle: conversation?.title, messageId, turnId,
    promptTokens: usage.prompt_tokens ?? usage.promptTokens ?? 0,
    completionTokens: usage.completion_tokens ?? usage.completionTokens ?? 0,
    totalTokens: usage.total_tokens ?? usage.totalTokens ??
      ((usage.prompt_tokens ?? usage.promptTokens ?? 0) + (usage.completion_tokens ?? usage.completionTokens ?? 0)),
  };
};

const finalizeCharge = async ({ userId, modelId, usage, conversationId, messageId }) => {
  const cost = await calculateCost({ modelId, usage });
  const apply = async (session) => {
    const context = await chargeContext({ userId, modelId, usage, conversationId, messageId, session });
    const balance = await tokenLedger.debit({ userId, amount: cost.appTokens, kind: "chat_charge",
      ...(messageId ? { key: `chat-message:${messageId}` } : {}), session,
      context: { ...context, costUsd: cost.usd } });
    if (messageId) {
      const result = await ChatMessage.updateOne({ _id: messageId, user: userId, role: "assistant" },
        { $set: { "meta.appTokens": cost.appTokens, "meta.costUsd": cost.usd } }, { session });
      if (!result.matchedCount) throw new Error("Billing message not found");
    }
    return { ...cost, balance: balance.appTokens, balanceVersion: balance.balanceVersion };
  };
  let session;
  try {
    // Legacy message billing and the balance receipt commit together. Its stable
    // message key also makes a retried finalization idempotent.
    if (!messageId) return await apply(undefined);
    session = await mongoose.startSession();
    const result = await session.withTransaction(() => apply(session));
    tokenLedger.notifyCommitted();
    return result;
  } catch (error) {
    if (error.code === "BALANCE_UPDATE_REJECTED") throw new Error("User not found");
    throw error;
  } finally {
    if (session) await session.endSession();
  }
};

// v2 path: ledger creation and balance mutation must happen in the same Mongo transaction.
const finalizeChargeInTransaction = async ({
  session,
  turnId,
  userId,
  modelId,
  usage,
  conversationId,
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
      kind: "chat_charge", key: `chat:${turnId}`, session,
      context: { ...await chargeContext({ userId, modelId, usage, conversationId, turnId, session }), costUsd: cost.usd } });
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
