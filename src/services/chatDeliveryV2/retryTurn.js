const { ChatTurn } = require("../../models");
const { errorFor } = require("./protocol");

const protocolError = (code) => {
  const error = new Error(code);
  error.protocolError = errorFor(code);
  return error;
};

const retryTurn = async ({ turnId, userId }) => {
  const updated = await ChatTurn.findOneAndUpdate(
    {
      turnId,
      user: userId,
      status: "failed",
      "error.retryable": true,
    },
    {
      $set: {
        status: "queued",
        lastSeq: 0,
        partialContent: "",
        error: null,
        processingStartedAt: null,
        leaseToken: null,
        leaseUntil: null,
      },
      $inc: { attempt: 1 },
    },
    { new: true },
  );

  if (updated) return updated;

  const existing = await ChatTurn.findOne({ turnId, user: userId })
    .select("_id status error.retryable")
    .lean();

  if (!existing) throw protocolError("TURN_NOT_FOUND");
  throw protocolError("TURN_NOT_RETRYABLE");
};

module.exports = retryTurn;
