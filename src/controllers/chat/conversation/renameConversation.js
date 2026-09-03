const { ChatConversation } = require("../../../models");

const renameConversation = async (req, res) => {
  try {
    const { id, title } = req.body;

    const chat = await ChatConversation.findOneAndUpdate(
      { _id: id, user: req.user.id, archived: false },
      { title },
      { new: true },
    );

    if (!chat) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.status(200).json({ success: true, chat });
  } catch (error) {
    console.error("Error in controller renameConversation:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = renameConversation;
