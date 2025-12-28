// controllers/chat/messages/editUserMessageAndRegenerate.js
const { ChatMessage, ChatConversation } = require("../../../models");

const editUserMessageAndRegenerate = async (req, res) => {
  const { id: messageId } = req.params;
  const { content } = req.body;
  const userId = req.user.id;

  if (!content) {
    return res.status(400).json({ error: "content required" });
  }

  /* 1️⃣ Находим сообщение */
  const message = await ChatMessage.findOne({
    _id: messageId,
    user: userId,
    role: "user",
    deleted: false,
  });

  if (!message) {
    return res.status(404).json({ error: "Message not found" });
  }

  /* 2️⃣ Обновляем текст */
  message.content = content;
  await message.save();

  /* 3️⃣ Удаляем ВСЕ ответы ассистента после него */
  await ChatMessage.updateMany(
    {
      conversation: message.conversation,
      role: "assistant",
      createdAt: { $gt: message.createdAt },
    },
    { deleted: true }
  );

  /* 4️⃣ Обновляем lastMessageAt */
  await ChatConversation.findByIdAndUpdate(message.conversation, {
    lastMessageAt: new Date(),
  });

  res.json({
    success: true,
    conversationId: message.conversation,
  });
};

module.exports = editUserMessageAndRegenerate;
