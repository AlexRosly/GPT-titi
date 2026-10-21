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
    attachments: message.attachments || [],
    webSources: message.webSources || [],
    fileResult: message.fileResult || null,
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

  if (assistant) [assistant] = await require("../files/messages").hydrate(turn.user, [assistant]);

  return {
    turnId: turn.turnId,
    clientMessageId: turn.clientMessageId,
    conversationId: turn.conversation.toString(),
    status: turn.status,
    attempt: turn.attempt,
    lastSeq: turn.lastSeq,
    partialContent: turn.partialContent || "",
    webStatus: turn.status === "processing" && turn.webPlan ? {
      stage: turn.webPlan.mode === "browser" ? (turn.browserState?.stage || "opening_browser") : turn.providerStartedAt ? "answering" : "reading_web",
      completed: turn.webState?.results?.length || 0, total: turn.webPlan.mode === "browser" ? 5 : turn.webPlan.urls.length
    } : null,
    outputFile: turn.outputFile || null,
    assistantMessage: messageDto(assistant),
    billing: turn.billing || null,
    error: turn.error || null,
    createdAt: toIso(turn.createdAt),
    updatedAt: toIso(turn.updatedAt),
  };
};

module.exports = { snapshot, messageDto };
