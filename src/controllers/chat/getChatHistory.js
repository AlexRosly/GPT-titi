// controllers/chat/getChatHistory.js
const { ChatMessage } = require("../../models");

const LIMIT = 20;

const getChatHistory = async (req, res) => {
  try {
    const userId = req.user.id;

    // 1️⃣ Берём последние 20 (по времени)
    const messages = await ChatMessage.find({
      user: userId,
    })
      .sort({ createdAt: -1 }) // последние
      .limit(HISTORY_LIMIT)
      .select("role content modelId createdAt")
      .lean();

    // 2️⃣ Разворачиваем в хронологический порядок
    messages.reverse();

    res.json({
      messages: messages.reverse(),
    });
  } catch (err) {
    console.error("getChatHistory error:", err);
    res.status(500).json({ error: "Failed to load chat history" });
  }
};

module.exports = getChatHistory;
