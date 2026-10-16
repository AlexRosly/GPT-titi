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

const { reserve } = require("./reservations");
const { APP_TOKEN_VALUE_USD } = require("../../config/billing");

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
  const { clientMessageId, conversationId, modelId, message, files = [], outputFile } = payload;

  const user = await User.findById(userId).select("_id appTokens status").lean();
  if (!user || user.status !== "active") throw protocolError("CONVERSATION_NOT_FOUND");

  const conversation = await ChatConversation.findOne({
    _id: conversationId,
    user: userId,
    archived: false,
  }).select("_id").lean();
  if (!conversation) throw protocolError("CONVERSATION_NOT_FOUND");

  const model = await ChatModels.findOne({ modelId, enabled: true }).select("modelId inputPerM outputPerM").lean();
  if (!model) throw protocolError("MODEL_NOT_AVAILABLE");

  if (!require("../files/config").enabled() && !files.some(f => f?.storage === "private")) await validateFilesOwnership(userId, files);

  if (outputFile) {
    require("../files/artifacts").outputSpec(outputFile);
    const allowed = (process.env.FILE_OUTPUT_MODELS || "").split(",").map(x => x.trim());
    const modelAllowed = allowed.includes("*") || allowed.includes(modelId);
    if (!require("../files/config").enabled() || !modelAllowed) throw protocolError("MODEL_NOT_AVAILABLE");
  }
  const requestHash = buildRequestHash({ userId, conversationId, modelId, message, files, outputFile });
  const existing = await findExistingTurn(userId, clientMessageId);
  if (existing) {
    if (existing.requestHash !== requestHash) throw protocolError("IDEMPOTENCY_CONFLICT");
    return { turn: existing, disposition: "duplicate" };
  }

  const estimatedTokens = estimateTokens(message);
  const estimate = await estimateCost(modelId, estimatedTokens);
  const turnId = crypto.randomUUID();
  const session = await mongoose.startSession();
  let result;

  try {
    result = await session.withTransaction(async () => {
      // A competing submission may have committed since the preflight read.
      // Recheck on every transaction retry before touching the shared balance.
      const duplicate = await ChatTurn.findOne({ user: userId, clientMessageId }).session(session).lean();
      if (duplicate) {
        if (duplicate.requestHash !== requestHash) throw protocolError("IDEMPOTENCY_CONFLICT");
        return { turn: duplicate, disposition: "duplicate" };
      }
      const canonicalFiles = (require("../files/config").enabled() || files.some(f => f?.storage === "private"))
        ? await require("../files/messages").resolve(userId, files, session) : files;
      await reserve({ userId, amount: estimate.appTokens, turnId, session });
      const [userMessage] = await ChatMessage.create(
        [{
          user: userId,
          conversation: conversationId,
          role: "user",
          content: message,
          modelId,
          tokens: estimatedTokens,
          attachments: canonicalFiles,
          turnId,
          clientMessageId,
          attempt: 1,
        }],
        { session },
      );

      const [createdTurn] = await ChatTurn.create(
        [{
          turnId,
          user: userId,
          conversation: conversationId,
          clientMessageId,
          requestHash,
          modelId,
          message,
          files: canonicalFiles,
          outputFile,
          reservedAppTokens: estimate.appTokens,
          reservationState: "held",
          pricing: { inputPerM: model.inputPerM, outputPerM: model.outputPerM, tokenValueUsd: APP_TOKEN_VALUE_USD },
          status: "queued",
          attempt: 1,
          userMessage: userMessage._id,
        }],
        { session },
      );
      return { turn: createdTurn.toObject(), disposition: "accepted" };
    });
  } catch (error) {
    if (error?.code === 11000 || error?.protocolError) {
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

  if (result.disposition === "accepted") require("../tokenLedger").notifyCommitted();
  return result;
};

module.exports = acceptTurn;
