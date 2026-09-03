const { Project, ChatConversation } = require("../../models");

const removeConversationFromProject = async (req, res) => {
  try {
    const { projectId, conversationId } = req.params;

    // Проверяем, что проект принадлежит пользователю
    const project = await Project.findOne({
      _id: projectId,
      user: req.user._id,
      deleted: null,
    });

    if (!project) {
      return res.status(404).json({
        message: "Project not found",
      });
    }

    // Проверяем, что чат действительно находится в этом проекте
    const conversation = await ChatConversation.findOne({
      _id: conversationId,
      user: req.user._id,
      project: projectId,
      archived: false,
    });

    if (!conversation) {
      return res.status(404).json({
        message: "Conversation not found in this project",
      });
    }

    // Просто убираем связь
    conversation.project = null;
    await conversation.save();

    // Обновляем активность проекта
    project.lastActivityAt = new Date();
    await project.save();

    res.json({
      success: true,
      message: "Conversation removed from project",
      conversationId,
    });
  } catch (err) {
    console.error("Error in removeConversationFromProject:", err);

    res.status(500).json({
      message: "Cannot remove conversation from project",
    });
  }
};

module.exports = removeConversationFromProject;
