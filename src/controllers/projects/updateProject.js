const mongoose = require("mongoose");
const { Project } = require("../../models");
const { updatePinnedState } = require("../../services/pinning");

const allowedFields = [
  "title",
  "description",
  "icon",
  "color",
  "defaultModel",
  "systemPrompt",
  "archived",
];

const updateProject = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        message: "Invalid project id",
      });
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "pinnedAt")) {
      return res.status(400).json({
        error: "PINNED_AT_IS_SERVER_MANAGED",
      });
    }

    const bodyKeys = Object.keys(req.body || {});
    const isPinRequest = bodyKeys.includes("pinned");

    if (isPinRequest) {
      if (bodyKeys.length !== 1 || typeof req.body.pinned !== "boolean") {
        return res.status(400).json({
          error: "INVALID_PIN_PAYLOAD",
        });
      }

      const project = await updatePinnedState({
        Model: Project,
        resourceId: req.params.id,
        userId: req.user._id,
        pinned: req.body.pinned,
        extraFilter: {
          deleted: null,
        },
      });

      if (!project) {
        return res.status(404).json({
          message: "Project not found",
        });
      }

      return res.status(200).json(project);
    }

    const unknownFields = bodyKeys.filter(
      (field) => !allowedFields.includes(field),
    );

    if (unknownFields.length > 0) {
      return res.status(400).json({
        error: "INVALID_PROJECT_UPDATE_FIELDS",
      });
    }

    const update = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        update[field] = req.body[field];
      }
    });

    const project = await Project.findOneAndUpdate(
      {
        _id: req.params.id,
        user: req.user._id,
        deleted: null,
      },
      update,
      {
        new: true,
      },
    );

    if (!project) {
      return res.status(404).json({
        message: "Project not found",
      });
    }

    res.json(project);
  } catch (err) {
    console.error("Error in controller updateProject:", err);

    res.status(500).json({
      message: "Cannot update project",
    });
  }
};

module.exports = updateProject;
