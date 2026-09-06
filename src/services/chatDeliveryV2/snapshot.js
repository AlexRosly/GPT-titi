const { ChatMessage } = require("../../models");

const toIso = (value) => (value ? new Date(value).toISOString() : null);

const messageDto = (message) => {
  if (!message) return null;
  return {
    id: message._id?.toString?.() || message.id,
    role: message.role,
    content: message.content,
    modelId: message.modelId,
    tokens: message.tokens || 0,
    turnId: message.turnId || null,
    createdAt: toIso(message.createdAt),
    updatedAt: toIso(message.updatedAt),
  };
};

const snapshot = async (turn) => {
  let assistant = null;
  if (turn.assistantMessage) {
    if (typeof turn.assistantMessage === "object" && turn.assistantMessage.role) {
      assistant = turn.assistantMessage;
    } else {
      assistant = await ChatMessage.findById(turn.assistantMessage).lean();
    }
  }

  return {
    turnId: turn.turnId,
    clientMessageId: turn.clientMessageId,
    conversationId: turn.conversation.toString(),
    status: turn.status,
    attempt: turn.attempt,
    lastSeq: turn.lastSeq,
    partialContent: turn.partialContent || "",
    assistantMessage: messageDto(assistant),
    billing: turn.billing || null,
    error: turn.error || null,
    createdAt: toIso(turn.createdAt),
    updatedAt: toIso(turn.updatedAt),
  };
};

module.exports = { snapshot, messageDto };
