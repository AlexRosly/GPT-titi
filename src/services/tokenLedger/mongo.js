const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const { User, TokenOperation, BalanceOutbox } = require("../../models");

class LedgerError extends Error {
  constructor(code, message, status = 409, details = {}) {
    super(message);
    Object.assign(this, { code, status, details });
  }
}

const balanceDto = (user) => ({
  userId: user._id.toString(),
  appTokens: user.appTokens,
  balanceVersion: user.balanceVersion || 0,
  nextClaimDate: user.nextDateClaimToken?.toISOString?.() || user.nextDateClaimToken || null,
});
const operationDto = (operation) => ({
  id: operation._id.toString(),
  kind: operation.kind,
  status: operation.status,
  source: operation.source,
  transactionHash: operation.transactionHash || null,
  createdAt: operation.createdAt,
});
const wake = () => require("../balanceOutbox").wake();

const inTransaction = async (session, action) => {
  if (session) return action(session);
  const owned = await mongoose.startSession();
  try {
    const result = await owned.withTransaction(() => action(owned), {
      readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary",
    });
    wake();
    return result;
  } finally {
    await owned.endSession();
  }
};

const assertAmount = (amount) => {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new LedgerError("INVALID_AMOUNT", "Token amount must be a non-negative safe integer.", 400);
  }
};
const receipt = (operation, userId) => {
  const entry = operation.entries.find((e) => String(e.user) === String(userId));
  if (!entry) throw new LedgerError("IDEMPOTENCY_CONFLICT", "Operation belongs to another account.");
  return {
    userId: String(userId), appTokens: entry.balance, balanceVersion: entry.balanceVersion,
    operation: operationDto(operation), alreadyApplied: true,
  };
};
const existingOperation = async (key, kind, userId, delta, session) => {
  const operation = await TokenOperation.findOne({ key }).session(session).lean();
  if (!operation) return null;
  const entry = operation.entries.find((e) => String(e.user) === String(userId));
  if (operation.kind !== kind || !entry || entry.delta !== delta) {
    throw new LedgerError("IDEMPOTENCY_CONFLICT", "Operation key was already used for different data.");
  }
  return receipt(operation, userId);
};

const record = async (key, kind, entries, session, requestSignature = null) => {
  const [operation] = await TokenOperation.create([{ key, kind, status: "confirmed", entries, requestSignature }], { session });
  await BalanceOutbox.create(entries.map((entry) => ({
    operation: operation._id, user: entry.user, balanceVersion: entry.balanceVersion, reason: kind,
  })), { session, ordered: true });
  return operation;
};

const mutate = async ({ userId, delta, kind, key = `${kind}:${randomUUID()}`, session, filter = {}, fields = {}, increments = {}, requestSignature = null }) => {
  assertAmount(Math.abs(delta));
  const action = async (activeSession) => {
    const existing = await existingOperation(key, kind, userId, delta, activeSession);
    if (existing) return existing;
    const user = await User.findOneAndUpdate(
      { _id: userId, ...filter },
      { $inc: { appTokens: delta, balanceVersion: 1, ...increments }, ...(Object.keys(fields).length ? { $set: fields } : {}) },
      { new: true, session: activeSession },
    ).lean();
    if (!user) throw new LedgerError("BALANCE_UPDATE_REJECTED", "Account cannot perform this token operation.");
    const operation = await record(key, kind, [{
      user: user._id, delta, balance: user.appTokens, balanceVersion: user.balanceVersion,
    }], activeSession, requestSignature);
    return { ...balanceDto(user), operation: operationDto(operation), alreadyApplied: false };
  };
  try {
    return await inTransaction(session, action);
  } catch (error) {
    if (!session && error?.code === 11000) {
      const existing = await existingOperation(key, kind, userId, delta, null);
      if (existing) return existing;
    }
    throw error;
  }
};

const getBalance = async (userId) => {
  const user = await User.findById(userId).select("appTokens balanceVersion nextDateClaimToken status").lean();
  if (!user || user.status === "deleted") throw new LedgerError("USER_NOT_FOUND", "Account not found.", 404);
  return balanceDto(user);
};
const getOperation = async (userId, operationId, { session = null } = {}) => {
  if (!mongoose.isValidObjectId(operationId)) throw new LedgerError("OPERATION_NOT_FOUND", "Operation not found.", 404);
  const operation = await TokenOperation.findOne({ _id: operationId, "entries.user": userId }).session(session).lean();
  if (!operation) throw new LedgerError("OPERATION_NOT_FOUND", "Operation not found.", 404);
  // Never expose another account's balance or wallet details.
  return { ...operationDto(operation), balance: receipt(operation, userId).appTokens };
};

const credit = ({ amount, ...options }) => {
  assertAmount(amount);
  return mutate({ ...options, delta: amount, filter: { ...options.filter, appTokens: { $lte: Number.MAX_SAFE_INTEGER - amount } } });
};
const debit = ({ amount, minBalance = null, ...options }) => {
  assertAmount(amount);
  return mutate({ ...options, delta: -amount, filter: {
    ...options.filter, ...(minBalance === null ? {} : { appTokens: { $gte: amount + minBalance } }),
  } });
};

const transfer = async ({ senderId, recipientId, amount, key, session }) => {
  assertAmount(amount);
  if (!amount) throw new LedgerError("INVALID_AMOUNT", "Transfer amount must be positive.", 400);
  if (String(senderId) === String(recipientId)) throw new LedgerError("SELF_TRANSFER", "Cannot transfer to yourself.", 400);
  if (!session) {
    const action = (activeSession) => transfer({ senderId, recipientId, amount, key, session: activeSession });
    try { return await inTransaction(null, action); } catch (error) {
      if (error?.code === 11000) return inTransaction(null, action);
      throw error;
    }
  }
  const existing = await TokenOperation.findOne({ key }).session(session).lean();
  if (existing) {
    const sender = existing.entries.find((entry) => String(entry.user) === String(senderId));
    const recipient = existing.entries.find((entry) => String(entry.user) === String(recipientId));
    if (existing.kind !== "transfer" || sender?.delta !== -amount || recipient?.delta !== amount) {
      throw new LedgerError("IDEMPOTENCY_CONFLICT", "Operation key was already used for different data.");
    }
    return { sender: receipt(existing, senderId), recipient: receipt(existing, recipientId), operation: operationDto(existing) };
  }
  const debited = await User.findOneAndUpdate(
    { _id: senderId, status: "active", appTokens: { $gte: amount } },
    { $inc: { appTokens: -amount, balanceVersion: 1 } }, { new: true, session },
  ).lean();
  if (!debited) throw new LedgerError("INSUFFICIENT_BALANCE", "Insufficient balance.");
  const credited = await User.findOneAndUpdate(
    { _id: recipientId, status: { $in: ["active", "blocked"] }, appTokens: { $lte: Number.MAX_SAFE_INTEGER - amount } },
    { $inc: { appTokens: amount, balanceVersion: 1 }, $set: { status: "active" } }, { new: true, session },
  ).lean();
  if (!credited) throw new LedgerError("RECIPIENT_UNAVAILABLE", "This account cannot receive tokens.");
  const operation = await record(key, "transfer", [
    { user: debited._id, delta: -amount, balance: debited.appTokens, balanceVersion: debited.balanceVersion },
    { user: credited._id, delta: amount, balance: credited.appTokens, balanceVersion: credited.balanceVersion },
  ], session);
  return { sender: balanceDto(debited), recipient: balanceDto(credited), operation: operationDto(operation) };
};

const claimBonus = async ({ userId, now = new Date(), amount = 10000 }) => inTransaction(null, async (session) => {
  const user = await User.findById(userId).session(session).lean();
  if (!user || user.status !== "active") throw new LedgerError("USER_NOT_ALLOWED", "User is not allowed.", 403);
  if (user.nextDateClaimToken && user.nextDateClaimToken > now) {
    return { ...balanceDto(user), success: false };
  }
  const nextClaimDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const result = await credit({
    userId, amount, kind: "bonus", key: `bonus:${userId}:${nextClaimDate.toISOString()}`, session,
    filter: { status: "active" }, fields: { dateClaimToken: now, nextDateClaimToken: nextClaimDate },
  });
  return { ...result, success: true, nextClaimDate };
});

const refund = async ({ userId, amount, key, session, minBalance = -1000, usd = 0 }) => {
  assertAmount(amount);
  return inTransaction(session, async (activeSession) => {
    const existing = await TokenOperation.findOne({ key }).session(activeSession).lean();
    const requestSignature = JSON.stringify({ amount, minBalance, usd });
    if (existing) {
      if (existing.kind !== "refund" || existing.requestSignature !== requestSignature) {
        throw new LedgerError("IDEMPOTENCY_CONFLICT", "Operation key was already used for different data.");
      }
      return receipt(existing, userId);
    }
    const user = await User.findById(userId).session(activeSession).lean();
    if (!user) throw new LedgerError("USER_NOT_FOUND", "Account not found.", 404);
    const delta = Math.max(user.appTokens - amount, minBalance) - user.appTokens;
    return mutate({ userId, delta, kind: "refund", key, session: activeSession, requestSignature,
      fields: { totalSpentUsd: Math.max(0, (user.totalSpentUsd || 0) - usd) } });
  });
};

const createAccount = async (details) => inTransaction(null, async (session) => {
  const [user] = await User.create([{ ...details, appTokens: 0, balanceVersion: 0 }], { session });
  await credit({ userId: user._id, amount: 10000, kind: "registration_bonus",
    key: `registration:${user._id}`, session });
  return User.findById(user._id).session(session);
});

module.exports = { createAccount, getBalance, getOperation, credit, debit, transfer, claimBonus, refund, notifyCommitted: wake, LedgerError };
