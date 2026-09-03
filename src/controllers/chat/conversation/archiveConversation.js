// controllers/chat/conversations/archiveConversation.js
const { ChatConversation } = require("../../../models");

const archiveConversation = async (req, res) => {
  try {
    const { id } = req.params;

    const chat = await ChatConversation.findOneAndUpdate(
      { _id: id, user: req.user.id },
      { archived: true },
      { new: true },
    );

    if (!chat) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error in controller archiveConversation:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = archiveConversation;
