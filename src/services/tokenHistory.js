const mongoose = require("mongoose");
const { TokenOperation, TokenTransfer, Payment, ChatTurn, User } = require("../models");
const { parseQuery, encodeCursor, decodeCursor, localDate } = require("./tokenHistoryQuery");

const objectId = (value) => new mongoose.Types.ObjectId(String(value));
const typeExpression = { $switch: { branches: [
  { case: { $eq: ["$kind", "topup"] }, then: "purchase" },
  { case: { $eq: ["$kind", "chat_charge"] }, then: "usage" },
  { case: { $in: ["$kind", ["bonus", "registration_bonus"]] }, then: "bonus" },
  { case: { $eq: ["$kind", "refund"] }, then: "refund" },
  { case: { $eq: ["$kind", "transfer"] }, then: { $cond: [{ $gt: ["$entry.delta", 0] }, "received", "sent"] } },
], default: "adjustment" } };
const prefix = (userId, options, { filterType = true, billing = false } = {}) => {
  const user = objectId(userId);
  const stages = [
    { $match: { "entries.user": user, status: "confirmed", kind: { $nin: ["reservation_hold", "reservation_release"] }, ...(Object.keys(options.createdAt).length ? { createdAt: options.createdAt } : {}) } },
    // Drop every other participant's financial receipt before doing any work.
    { $project: { key: 1, kind: 1, status: 1, source: 1, transactionHash: 1, context: 1, createdAt: 1,
      entry: { $arrayElemAt: [{ $filter: { input: "$entries", as: "entry", cond: { $eq: ["$$entry.user", user] } } }, 0] } } },
    { $set: { type: typeExpression, day: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: options.timeZone } } } },
  ];
  if (filterType && options.type !== "all") stages.push({ $match: { type: options.type === "nonusage" ? { $ne: "usage" } : options.type } });
  if (billing) stages.push(
    { $set: { legacyTurnId: { $cond: [{ $regexMatch: { input: "$key", regex: /^chat:/ } }, { $substrBytes: ["$key", 5, { $subtract: [{ $strLenBytes: "$key" }, 5] }] }, null] } } },
    { $lookup: { from: "chatbillingledgers", localField: "legacyTurnId", foreignField: "turnId", as: "billing" } },
    { $set: { billing: { $arrayElemAt: [{ $filter: { input: "$billing", as: "bill", cond: { $eq: ["$$bill.user", user] } } }, 0] } } },
    { $set: { modelId: { $ifNull: ["$context.modelId", "$billing.modelId"] },
      costUsd: { $ifNull: ["$context.costUsd", "$billing.usd"] },
      totalTokens: { $ifNull: ["$context.totalTokens", "$billing.totalTokens"] } } },
  );
  return stages;
};
const aggregate = (stages) => TokenOperation.aggregate(stages).allowDiskUse(true).option({ maxTimeMS: 15000 });

// Older ledger entries have no display context. Resolve only unambiguous links
// (operation ID / Stripe key / v2 turn ID); never infer a charge from timestamps.
const decorate = async (userId, operations) => {
  if (!operations.length) return [];
  const user = objectId(userId);
  const ids = operations.map((operation) => operation._id);
  const turnIds = operations.filter((o) => o.key.startsWith("chat:")).map((o) => o.key.slice(5));
  const paymentIds = operations.map((o) => o.context?.paymentId || (o.key.startsWith("stripe:refund:") ? o.key.slice(14) : null)).filter((id) => id && mongoose.isValidObjectId(id));
  const sessions = operations.filter((o) => o.key.startsWith("stripe:checkout:")).map((o) => o.key.slice(16));
  const [transfers, payments, turns] = await Promise.all([
    TokenTransfer.find({ operation: { $in: ids }, $or: [{ sender: user }, { recipient: user }] }).select("operation sender recipient recipientEmail").lean(),
    Payment.find({ user, $or: [{ _id: { $in: paymentIds } }, { stripeSessionId: { $in: sessions } }] }).select("amount currency stripeSessionId").lean(),
    ChatTurn.find({ user, turnId: { $in: turnIds } }).select("turnId conversation modelId").lean(),
  ]);
  const byOperation = new Map(transfers.map((v) => [String(v.operation), v]));
  const byPayment = new Map(payments.map((v) => [String(v._id), v]));
  const bySession = new Map(payments.map((v) => [v.stripeSessionId, v]));
  const byTurn = new Map(turns.map((v) => [v.turnId, v]));
  const senders = transfers.filter((v) => String(v.recipient) === String(userId)).map((v) => v.sender);
  const users = await User.find({ _id: { $in: senders } }).select("email").lean();
  const emails = new Map(users.map((v) => [String(v._id), v.email]));
  return operations.map((operation) => {
    const context = operation.context || {};
    const transfer = byOperation.get(String(operation._id));
    const payment = byPayment.get(String(context.paymentId || operation.key.slice(14))) || bySession.get(operation.key.slice(16));
    const turn = byTurn.get(context.turnId || operation.key.slice(5));
    const peer = operation.type === "sent" ? context.recipientEmail || transfer?.recipientEmail
      : operation.type === "received" ? context.senderEmail || emails.get(String(transfer?.sender)) : null;
    return {
      id: String(operation._id), type: operation.type, kind: operation.kind,
      at: operation.createdAt.toISOString(), day: operation.day,
      amount: operation.entry.delta, balanceAfter: operation.entry.balance,
      balanceVersion: operation.entry.balanceVersion, status: operation.status,
      model: context.modelId || operation.modelId || turn?.modelId || null,
      conversationId: context.conversationId ? String(context.conversationId) : turn?.conversation ? String(turn.conversation) : null,
      chat: context.conversationTitle || null, peer: peer || null,
      payment: ["purchase", "refund"].includes(operation.type) ? {
        id: context.paymentId ? String(context.paymentId) : payment ? String(payment._id) : null,
        amountMinor: context.paymentAmountMinor ?? payment?.amount ?? null,
        currency: context.paymentCurrency ?? payment?.currency ?? null,
      } : null,
      bonusReason: operation.kind === "registration_bonus" ? "registration" : operation.kind === "bonus" ? "weekly" : null,
      detailsAvailable: operation.type !== "usage" || Boolean(context.modelId || operation.modelId || turn?.modelId),
    };
  });
};
const readDetailed = async (userId, options) => {
  const position = decodeCursor(userId, options);
  const stages = prefix(userId, options);
  const baseLength = stages.length;
  if (position) stages.push({ $match: { $or: [
    { createdAt: { $lt: position.at } }, { createdAt: position.at, _id: { $lt: position.id } },
  ] } });
  stages.push({ $sort: { createdAt: -1, _id: -1 } }, { $limit: options.limit + 1 });
  stages.push(...prefix(userId, options, { billing: true }).slice(baseLength));
  const rows = await aggregate(stages);
  const more = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return { items: await decorate(userId, page), nextCursor: more ? encodeCursor(userId, options, { at: last.createdAt.toISOString(), id: String(last._id) }) : null };
};
const getHistory = async (userId, query) => {
  const options = parseQuery(query);
  if (options.mode === "detailed") return { mode: options.mode, timeZone: options.timeZone, ...await readDetailed(userId, options) };
  const position = decodeCursor(userId, options);
  const stages = prefix(userId, options, { billing: true });
  if (position) stages.push({ $match: { day: { $lt: position.day } } });
  stages.push({ $group: { _id: "$day", operationCount: { $sum: 1 },
    usageAmount: { $sum: { $cond: [{ $eq: ["$type", "usage"] }, "$entry.delta", 0] } },
    chargeCount: { $sum: { $cond: [{ $eq: ["$type", "usage"] }, 1, 0] } },
    unknownModelCharges: { $sum: { $cond: [{ $and: [{ $eq: ["$type", "usage"] }, { $eq: [{ $ifNull: ["$modelId", null] }, null] }] }, 1, 0] } },
    models: { $addToSet: { $cond: [{ $eq: ["$type", "usage"] }, { $ifNull: ["$modelId", null] }, null] } },
  } }, { $sort: { _id: -1 } }, { $limit: options.limit + 1 });
  const rows = await aggregate(stages);
  const days = [];
  for (const row of rows.slice(0, options.limit)) {
    const type = options.type === "all" ? "nonusage" : options.type;
    const activityQuery = { mode: "detailed", type, from: row._id, to: row._id, timeZone: options.timeZone, limit: "100" };
    const activity = type === "usage" ? { items: [], nextCursor: null } : await readDetailed(userId, parseQuery(activityQuery));
    days.push({ day: row._id, operationCount: row.operationCount, activity: activity.items,
      nextActivityCursor: activity.nextCursor, activityQuery,
      usage: row.chargeCount ? { amount: row.usageAmount, chargeCount: row.chargeCount,
        modelCount: row.models.filter(Boolean).length, unknownModelCharges: row.unknownModelCharges } : null });
  }
  return { mode: "general", timeZone: options.timeZone, days,
    nextCursor: rows.length > options.limit ? encodeCursor(userId, options, { day: days.at(-1).day }) : null };
};
const getDayCharges = (userId, selectedDay, query) => getHistory(userId, {
  ...query, mode: "detailed", type: "usage", day: selectedDay,
});
const getSummary = async (userId, query) => {
  const options = parseQuery(query, { mode: "detailed", type: "all", cursor: undefined });
  const [totals, first] = await Promise.all([
    aggregate([...prefix(userId, options, { filterType: false }), { $group: { _id: null,
      incoming: { $sum: { $max: ["$entry.delta", 0] } }, outgoing: { $sum: { $min: ["$entry.delta", 0] } },
      netChange: { $sum: "$entry.delta" }, operationCount: { $sum: 1 },
    } }, { $project: { _id: 0, incoming: 1, outgoing: 1, netChange: 1, operationCount: 1 } }]),
    TokenOperation.findOne({ "entries.user": objectId(userId), status: "confirmed" }).sort({ createdAt: 1, _id: 1 }).select("createdAt").lean(),
  ]);
  return { ...(totals[0] || { incoming: 0, outgoing: 0, netChange: 0, operationCount: 0 }),
    from: options.from || null, to: options.to || null, timeZone: options.timeZone,
    coverage: { source: "token-ledger", firstRecordedAt: first?.createdAt.toISOString() || null, includesPreLedgerHistory: false } };
};
const getUsageSummary = async (userId, query = {}) => {
  const options = parseQuery(query, { mode: "detailed", type: "usage", cursor: undefined });
  const rows = await aggregate([...prefix(userId, options, { billing: true }), { $group: {
    _id: { $ifNull: ["$modelId", null] }, tokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
    usd: { $sum: { $ifNull: ["$costUsd", 0] } }, appTokens: { $sum: { $multiply: ["$entry.delta", -1] } },
    chargeCount: { $sum: 1 },
  } }, { $sort: { _id: 1 } }]);
  return { totalTokens: rows.reduce((s, r) => s + r.tokens, 0), totalUsd: rows.reduce((s, r) => s + r.usd, 0),
    byModel: rows.map((r) => ({ model: r._id, tokens: r.tokens, usd: r.usd, appTokens: r.appTokens, chargeCount: r.chargeCount })),
    source: "token-ledger", includesPreLedgerHistory: false };
};
const getUsageDays = async (userId, query = {}) => {
  const text = query.days === undefined ? "7" : query.days;
  if (typeof text !== "string" || !/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 366) {
    const { HistoryError } = require("./tokenHistoryQuery");
    throw new HistoryError("days must be between 1 and 366.");
  }
  const options = parseQuery(query, { mode: "detailed", type: "usage", cursor: undefined });
  if (!options.from && !options.to) options.createdAt = { $gte: new Date(Date.now() - Number(text) * 86400000) };
  return aggregate([...prefix(userId, options, { billing: true }), { $group: {
    _id: { day: "$day" }, tokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
    usd: { $sum: { $ifNull: ["$costUsd", 0] } }, appTokens: { $sum: { $multiply: ["$entry.delta", -1] } },
  } }, { $sort: { "_id.day": 1 } }]);
};
module.exports = { getHistory, getDayCharges, getSummary, getUsageSummary, getUsageDays, localDate };
