// controllers/chat/conversations/forkConversation.js
const { ChatConversation, ChatMessage } = require("../../../models");

const forkConversation = async (req, res) => {
  const { id: conversationId } = req.params;
  const { messageId } = req.body;
  const userId = req.user.id;

  if (!messageId) {
    return res.status(400).json({ error: "messageId required" });
  }

  /* 1️⃣ Исходный чат */
  const conversation = await ChatConversation.findOne({
    _id: conversationId,
    user: userId,
  });

  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  /* 2️⃣ Сообщение, от которого форкаемся */
  const pivotMessage = await ChatMessage.findOne({
    _id: messageId,
    conversation: conversationId,
    user: userId,
    deleted: false,
  });

  if (!pivotMessage) {
    return res.status(404).json({ error: "Message not found" });
  }

  /* 3️⃣ Создаём новый чат */
  const newConversation = await ChatConversation.create({
    user: userId,
    title: conversation.title + " (fork)",
    modelId: conversation.modelId,
  });

  /* 4️⃣ Копируем сообщения ДО pivot */
  const messagesToCopy = await ChatMessage.find({
    conversation: conversationId,
    user: userId,
    deleted: false,
    createdAt: { $lte: pivotMessage.createdAt },
  })
    .sort({ createdAt: 1 })
    .lean();

  const clonedMessages = messagesToCopy.map((m) => ({
    user: m.user,
    conversation: newConversation._id,
    role: m.role,
    content: m.content,
    modelId: m.modelId,
    tokens: m.tokens,
    meta: m.meta,
    createdAt: m.createdAt,
  }));

  await ChatMessage.insertMany(clonedMessages);

  res.status(201).json({
    conversationId: newConversation._id,
  });
};

module.exports = forkConversation;
