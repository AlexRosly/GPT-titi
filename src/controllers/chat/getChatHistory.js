const { ChatMessage } = require("../../models");
const historyMessageDto = require("../../services/chatDeliveryV2/historyMessageDto");

const HISTORY_LIMIT = 20;

const getChatHistory = async (req, res) => {
  try {
    const userId = req.user.id;

    const messages = await ChatMessage.find({
      user: userId,
      deleted: null,
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(HISTORY_LIMIT)
      .select("role content modelId tokens attachments turnId clientMessageId attempt createdAt updatedAt")
      .lean();

    res.json({
      messages: messages.reverse().map(historyMessageDto),
    });
  } catch (err) {
    console.error("getChatHistory error:", err);
    res.status(500).json({ error: "Failed to load chat history" });
  }
};

module.exports = getChatHistory;
