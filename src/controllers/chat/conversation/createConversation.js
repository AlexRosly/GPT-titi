// controllers/chat/conversations/createConversation.js
const { ChatConversation } = require("../../../models");

const createConversation = async (req, res) => {
  const { title, modelId } = req.body;
  try {
    const conversation = await ChatConversation.create({
      user: req.user.id,
      title: title || "New chat",
      modelId,
    });

    res.status(201).json(conversation);
  } catch (error) {
    console.error("Error in controller createConversation:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = createConversation;
