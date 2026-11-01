const mongoose = require("mongoose");
const { Project, ChatConversation } = require("../../models");
const { buildPinnedAtExpression } = require("../../services/pinning");

module.exports = async (req, res) => {
  const { projectId, conversationId } = req.params;
  if (![projectId, conversationId].every((id) => mongoose.Types.ObjectId.isValid(id))) {
    return res.status(400).json({ error: "INVALID_PROJECT_CONVERSATION_ID" });
  }
  const keys = Object.keys(req.body || {});
  if (keys.length !== 1 || keys[0] !== "pinned" || typeof req.body.pinned !== "boolean") {
    return res.status(400).json({ error: "INVALID_PIN_PAYLOAD" });
  }
  try {
    const owned = await Project.exists({ _id: projectId, user: req.user._id, deleted: null });
    if (!owned) return res.status(404).json({ error: "PROJECT_NOT_FOUND" });

    const conversation = await ChatConversation.findOneAndUpdate(
      { _id: conversationId, user: req.user._id, project: projectId, archived: false },
      [{ $set: { projectPinnedAt: buildPinnedAtExpression(req.body.pinned, "projectPinnedAt") } }],
      { new: true, updatePipeline: true, timestamps: false },
    );
    if (!conversation) return res.status(404).json({ error: "CONVERSATION_NOT_FOUND_IN_PROJECT" });

    return res.json({ projectId, conversationId, projectPinnedAt: conversation.projectPinnedAt ?? null });
  } catch (error) {
    console.error("Cannot update project chat pin:", error);
    return res.status(500).json({ error: "PROJECT_PIN_UPDATE_FAILED" });
  }
};
