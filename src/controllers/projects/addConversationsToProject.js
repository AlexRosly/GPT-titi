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

    const modified = await require("../../services/files/store").transaction(async session => {
    const project = await Project.findOneAndUpdate({
      _id: projectId,
      user: req.user._id,
      deleted: null,
    }, { $set: { lastActivityAt: new Date() } }, { new: true, session });

    if (!project) {
      throw require("../../services/files/validation").fail("PROJECT_NOT_FOUND", 404);
    }

    const result = await ChatConversation.updateMany(
      {
        _id: {
          $in: conversationIds,
        },
        user: req.user._id,
        archived: false,
      },
      [{
        $set: {
          projectPinnedAt: {
            $cond: [
              { $eq: ["$project", project._id] },
              { $ifNull: ["$projectPinnedAt", null] },
              null,
            ],
          },
          project: project._id,
        },
      }],
      { updatePipeline: true, session },
    );

    return result.modifiedCount;
    });

    res.json({
      success: true,
      modified,
    });
  } catch (err) {
    if (err.fileError) return res.status(err.status).json({message:"Project not found"});
    console.error("Error in addConversationsToProject:", err);

    res.status(500).json({
      message: "Cannot add conversations",
    });
  }
};

module.exports = addConversationsToProject;
