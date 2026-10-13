const { User, ChatTurn } = require("../../models");
const ledger = require("../tokenLedger");
const { errorFor } = require("./protocol");

const NEGATIVE_LIMIT = -1000;
const availableExpression = { $subtract: ["$appTokens", { $ifNull: ["$reservedAppTokens", 0] }] };
const protocolError = (code, details) => Object.assign(new Error(code), {
  protocolError: { ...errorFor(code), ...(details ? { details } : {}) },
});

// Must share the transaction that creates/requeues the turn. All admissions and
// transfers write the same User document, so concurrent requests serialize.
const reserve = async ({ userId, amount, turnId, attempt = 1, session }) => {
  if (!session || !Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid reservation");
  const user = await User.findById(userId).session(session).lean();
  if (!user || user.status !== "active") throw protocolError("CONVERSATION_NOT_FOUND");
  const details = { balance: user.appTokens, availableTokens: user.appTokens - (user.reservedAppTokens || 0), estimatedTokens: amount };
  if (user.appTokens < NEGATIVE_LIMIT) throw protocolError("BALANCE_LIMIT_EXCEEDED", details);
  if (details.availableTokens < amount) throw protocolError("INSUFFICIENT_BALANCE", details);
  const limit = Number(process.env.CHAT_V2_MAX_PENDING_PER_USER || 4);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid CHAT_V2_MAX_PENDING_PER_USER");
  const active = await ChatTurn.countDocuments({ user: userId, status: { $in: ["queued", "processing"] } }).session(session);
  if (active >= limit) throw protocolError("TURN_ALREADY_PROCESSING");
  await ledger.changeReservation({ userId, amount, turnId, attempt, session,
    filter: { status: "active", appTokens: { $gte: NEGATIVE_LIMIT }, $expr: { $gte: [availableExpression, amount] } },
  });
};

const release = async (turn, session, state = "released") => {
  if (turn.reservationState !== "held") return;
  const changed = await ChatTurn.updateOne({ _id: turn._id, reservationState: "held", attempt: turn.attempt },
    { $set: { reservationState: state, reservationClosedAt: new Date() } }, { session });
  if (!changed.modifiedCount) throw new Error("Reservation ownership changed");
  await ledger.changeReservation({ userId: turn.user, amount: turn.reservedAppTokens,
    turnId: turn.turnId, attempt: turn.attempt, releasing: true, session,
    filter: { reservedAppTokens: { $gte: turn.reservedAppTokens } },
  });
};

module.exports = { reserve, release, availableExpression, NEGATIVE_LIMIT, protocolError };
