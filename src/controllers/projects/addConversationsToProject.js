const { Project, ChatConversation } = require("../../models");

const addConversationsToProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { conversationIds } = req.body;

    if (!Array.isArray(conversationIds) || !conversationIds.length) {
      return res.status(400).json({
        message: "conversationIds is required",
      });
    }

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

    const result = await ChatConversation.updateMany(
      {
        _id: {
          $in: conversationIds,
        },
        user: req.user._id,
        archived: false,
      },
      {
        $set: {
          project: project._id,
        },
      },
    );

    project.lastActivityAt = new Date();
    await project.save();

    res.json({
      success: true,
      modified: result.modifiedCount,
    });
  } catch (err) {
    console.error("Error in addConversationsToProject:", err);

    res.status(500).json({
      message: "Cannot add conversations",
    });
  }
};

module.exports = addConversationsToProject;
