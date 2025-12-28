// controllers/chat/conversations/getConversations.js
const { ChatConversation } = require("../../../models");

const getConversation = async (req, res) => {
  const chats = await ChatConversation.find({
    user: req.user.id,
    archived: false,
  })
    .sort({ lastMessageAt: -1 })
    .select("_id title lastMessageAt createdAt");

  res.json(chats);
};
module.exports = getConversation;
