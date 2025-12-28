// controllers/chat/conversations/clearConversationMessages.js
const { ChatMessage, ChatConversation } = require("../../../models");

const clearConversationMessages = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const conversation = await ChatConversation.findOne({
    _id: id,
    user: userId,
  });

  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  await ChatMessage.updateMany(
    {
      conversation: id,
      user: userId,
      deleted: false,
    },
    { deleted: true }
  );

  await ChatConversation.findByIdAndUpdate(id, {
    lastMessageAt: new Date(),
    summary: "",
  });

  res.json({ success: true });
};

module.exports = clearConversationMessages;
