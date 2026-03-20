// controllers/chat/messages/editUserMessageAndRegenerate.js
const { ChatMessage, ChatConversation } = require("../../../models");

const editUserMessageAndRegenerate = async (req, res) => {
  const { id: messageId } = req.params;
  const { content } = req.body;
  const userId = req.user.id;

  if (!content) {
    return res.status(400).json({ error: "content required" });
  }

  /* 1️⃣ Находим user-сообщение (НЕ удалённое) */
  const message = await ChatMessage.findOne({
    _id: messageId,
    user: userId,
    role: "user",
    deletedAt: null,
  });

  if (!message) {
    return res.status(404).json({ error: "Message not found" });
  }

  /* 2️⃣ Обновляем текст user message */
  await ChatMessage.updateOne(
    { _id: message._id },
    {
      content,
      deletedAt: null, // на всякий случай
    }
  );

  /* 3️⃣ Soft-delete ВСЕ ответы ассистента после этого сообщения */
  await ChatMessage.updateMany(
    {
      conversation: message.conversation,
      role: "assistant",
      deletedAt: null,
      createdAt: { $gt: message.createdAt },
    },
    {
      deletedAt: new Date(),
    }
  );

  /* 4️⃣ Обновляем lastMessageAt у conversation */
  await ChatConversation.findByIdAndUpdate(message.conversation, {
    lastMessageAt: new Date(),
  });

  /* 5️⃣ Фронт дальше вызывает /regenerate или /stream */
  res.json({
    success: true,
    conversationId: message.conversation,
  });
};

module.exports = editUserMessageAndRegenerate;
