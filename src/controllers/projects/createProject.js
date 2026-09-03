const { Project } = require("../../models");

const createProject = async (req, res) => {
  try {
    const project = await Project.create({
      user: req.user._id,

      title: req.body.title || "New project",
      description: req.body.description || "",

      icon: req.body.icon || "folder",
      color: req.body.color || "#3B82F6",

      defaultModel: req.body.defaultModel || "gpt-5.5",

      systemPrompt: req.body.systemPrompt || "",
    });
    res.status(201).json(project);
  } catch (err) {
    console.error("Error in controller createProject:", err);

    res.status(500).json({
      message: "Cannot create project",
    });
  }
};

module.exports = createProject;
