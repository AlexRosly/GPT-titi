// controllers/chat/conversations/getConversations.js
const { ChatConversation } = require("../../../models");
const { CONVERSATION_SORT } = require("../../../services/pinning");

const getConversation = async (req, res) => {
  try {
    const chats = await ChatConversation.find({
      user: req.user.id,
      archived: false,
    })
      .sort(CONVERSATION_SORT)
      .select("_id title lastMessageAt createdAt project pinnedAt")
      .populate({
        path: "project",
        select: "_id title color icon pinnedAt",
      })
      .lean();

    const result = chats.map((chat) => ({
      ...chat,
      pinnedAt: chat.pinnedAt ?? null,
    }));

    res.status(200).json(result);
  } catch (error) {
    console.error("Error in controller getConversation:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};
module.exports = getConversation;
