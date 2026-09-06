const crypto = require("crypto");
const mongoose = require("mongoose");
const {
  User,
  ChatModels,
  ChatMessage,
  ChatConversation,
  ChatTurn,
  FileModels,
} = require("../../models");
const { estimateTokens, estimateCost } = require("../../utils");
const { buildRequestHash, errorFor } = require("./protocol");

const NEGATIVE_LIMIT = -1000;

const protocolError = (code) => Object.assign(new Error(), { protocolError: errorFor(code) });

const validateFilesOwnership = async (userId, files = []) => {
  for (const file of files) {
    const id = file?.id || file?._id || file?.fileId;
    if (!id) continue;
    if (!mongoose.isValidObjectId(id)) throw protocolError("INVALID_ENVELOPE");
    const owned = await FileModels.findOne({ _id: id, user: userId }).select("_id").lean();
    if (!owned) throw protocolError("CONVERSATION_NOT_FOUND");
  }
};

const findExistingTurn = async (userId, clientMessageId) =>
  ChatTurn.findOne({ user: userId, clientMessageId }).lean();

const acceptTurn = async ({ userId, payload }) => {
  const { clientMessageId, conversationId, modelId, message, files = [] } = payload;

  const user = await User.findById(userId).select("_id appTokens status").lean();
  if (!user || user.status !== "active") throw protocolError("CONVERSATION_NOT_FOUND");

  const conversation = await ChatConversation.findOne({
    _id: conversationId,
    user: userId,
    archived: false,
  }).select("_id").lean();
  if (!conversation) throw protocolError("CONVERSATION_NOT_FOUND");

  const model = await ChatModels.findOne({ modelId, enabled: true }).select("modelId").lean();
  if (!model) throw protocolError("MODEL_NOT_AVAILABLE");

  await validateFilesOwnership(userId, files);

  const estimatedTokens = estimateTokens(message);
  const estimate = await estimateCost(modelId, estimatedTokens);
  if (user.appTokens - estimate.appTokens < NEGATIVE_LIMIT) {
    throw protocolError("INSUFFICIENT_BALANCE");
  }

  const requestHash = buildRequestHash({ userId, conversationId, modelId, message, files });
  const existing = await findExistingTurn(userId, clientMessageId);
  if (existing) {
    if (existing.requestHash !== requestHash) throw protocolError("IDEMPOTENCY_CONFLICT");
    return { turn: existing, disposition: "duplicate" };
  }

  const turnId = crypto.randomUUID();
  const session = await mongoose.startSession();
  let createdTurn;

  try {
    await session.withTransaction(async () => {
      const [userMessage] = await ChatMessage.create(
        [{
          user: userId,
          conversation: conversationId,
          role: "user",
          content: message,
          modelId,
          tokens: estimatedTokens,
          attachments: files,
          turnId,
          clientMessageId,
          attempt: 1,
        }],
        { session },
      );

      [createdTurn] = await ChatTurn.create(
        [{
          turnId,
          user: userId,
          conversation: conversationId,
          clientMessageId,
          requestHash,
          modelId,
          message,
          files,
          status: "queued",
          attempt: 1,
          userMessage: userMessage._id,
        }],
        { session },
      );
    });
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate = await findExistingTurn(userId, clientMessageId);
      if (duplicate) {
        if (duplicate.requestHash !== requestHash) throw protocolError("IDEMPOTENCY_CONFLICT");
        return { turn: duplicate, disposition: "duplicate" };
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return { turn: createdTurn.toObject(), disposition: "accepted" };
};

module.exports = acceptTurn;
