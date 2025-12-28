// controllers/chat/conversations/archiveConversation.js
const { ChatConversation } = require("../../../models");

const archiveConversation = async (req, res) => {
  const { id } = req.params;

  const chat = await ChatConversation.findOneAndUpdate(
    { _id: id, user: req.user.id },
    { archived: true },
    { new: true }
  );

  if (!chat) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.json({ success: true });
};

module.exports = archiveConversation;
