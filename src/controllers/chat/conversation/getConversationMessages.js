// controllers/chat/conversations/getConversationMessages.js
const { ChatMessage, ChatConversation } = require("../../../models");

const getConversationMessages = async (req, res) => {
  const { id } = req.params;
  const limit = Number(req.query.limit) || 20;

  const conversation = await ChatConversation.findOne({
    _id: id,
    user: req.user.id,
  });

  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  const messages = await ChatMessage.find({
    conversation: id,
    user: req.user.id,
    deleted: false,
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.json(messages.reverse());
};

module.exports = getConversationMessages;
