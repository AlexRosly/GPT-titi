// controllers/chat/conversations/archiveConversation.js

const archiveConversation = async (req, res) => {
  try {
    const { id } = req.params;

    const value = req.query?.deleteFiles;
    if (value !== undefined && value !== "true" && value !== "false")
      return res.status(400).json({ error: "INVALID_DELETE_FILES" });
    const result = await require("../../../services/files/deleteConversationFiles")(
      req.user.id, id, value === "true");
    res.status(200).json(result);
  } catch (error) {
    if (error.fileError) return res.status(error.status).json({ error: error.fileError, message: error.fileError === "CHAT_BUSY_STOP_BEFORE_DELETE" ? "Stop the active response and wait for it to finish before deleting this chat and its files." : "Conversation not found." });
    console.error("Error in controller archiveConversation:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = archiveConversation;
