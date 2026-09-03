const { Project, ChatConversation } = require("../../models");

const deleteProject = async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      user: req.user._id,
      deleted: null,
    });

    if (!project) {
      return res.status(404).json({
        message: "Project not found",
      });
    }

    project.deleted = new Date();

    await project.save();

    await ChatConversation.updateMany(
      {
        project: project._id,
      },
      {
        $set: {
          project: null,
        },
      },
    );

    res.json({
      success: true,
    });
  } catch (err) {
    console.error("Error in controller deleteProject:", err);

    res.status(500).json({
      message: "Cannot delete project",
    });
  }
};

module.exports = deleteProject;
