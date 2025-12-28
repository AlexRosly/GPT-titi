// controllers/chat/conversations/createConversation.js
const { ChatConversation } = require("../../../models");

const createConversation = async (req, res) => {
  const conversation = await ChatConversation.create({
    user: req.user.id,
    title: req.body.title || "New chat",
  });

  res.status(201).json(conversation);
};

module.exports = createConversation;
