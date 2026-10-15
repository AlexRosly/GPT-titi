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

  await require("../../../services/files/store").transaction(async (session) => {
    const messages = await ChatMessage.find({ conversation: id, user: userId, deleted: null }).session(session);
    const fileIds = messages.flatMap(m => m.attachments.filter(f => f.storage === "private").map(f => f.fileId));
    await ChatMessage.updateMany({ conversation: id, user: userId }, { $set: { deleted: new Date() } }, { session });
    await require("../../../services/files/messages").removeUnreferenced(userId, fileIds, session);
  });

  await ChatConversation.findByIdAndUpdate(id, {
    lastMessageAt: new Date(),
    summary: "",
  });

  res.json({ success: true });
};

module.exports = clearConversationMessages;
