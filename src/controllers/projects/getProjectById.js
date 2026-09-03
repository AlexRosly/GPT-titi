const { Project, ChatConversation } = require("../../models");
const { CONVERSATION_SORT } = require("../../services/pinning");

const getProjectById = async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      user: req.user._id,
      deleted: null,
    }).lean();

    if (!project) {
      return res.status(404).json({
        message: "Project not found",
      });
    }

    const conversations = await ChatConversation.find({
      user: req.user._id,
      project: project._id,
      archived: false,
    })
      .sort(CONVERSATION_SORT)
      .lean();

    res.json({
      ...project,
      pinnedAt: project.pinnedAt ?? null,
      conversations: conversations.map((conversation) => ({
        ...conversation,
        pinnedAt: conversation.pinnedAt ?? null,
      })),
    });
  } catch (err) {
    if (err?.name === "CastError") {
      return res.status(400).json({
        message: "Invalid project id",
      });
    }

    console.error("Error in controller getProjectById:", err);

    res.status(500).json({
      message: "Cannot get project",
    });
  }
};

module.exports = getProjectById;
