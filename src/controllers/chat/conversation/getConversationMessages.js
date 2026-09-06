const { ChatMessage, ChatConversation } = require("../../../models");
const historyMessageDto = require("../../../services/chatDeliveryV2/historyMessageDto");

const getConversationMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const conversation = await ChatConversation.findOne({
      _id: id,
      user: req.user.id,
    }).select("_id");

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const messages = await ChatMessage.find({
      conversation: id,
      user: req.user.id,
      deleted: null,
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    res.json(messages.reverse().map(historyMessageDto));
  } catch (error) {
    console.error("Error in controller getConversationMessages:", error);
    res.status(500).json({ status: 500, message: "Internal server error" });
  }
};

module.exports = getConversationMessages;
