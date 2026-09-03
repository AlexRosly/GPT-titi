const { ChatConversation } = require("../../../models");
const { updatePinnedState } = require("../../../services/pinning");

const updateConversationPin = async (req, res) => {
  try {
    const bodyKeys = Object.keys(req.body || {});

    if (
      bodyKeys.length !== 1 ||
      bodyKeys[0] !== "pinned" ||
      typeof req.body.pinned !== "boolean"
    ) {
      return res.status(400).json({
        error: "INVALID_PIN_PAYLOAD",
      });
    }

    const conversation = await updatePinnedState({
      Model: ChatConversation,
      resourceId: req.params.id,
      userId: req.user._id,
      pinned: req.body.pinned,
      extraFilter: {
        archived: false,
      },
    });

    if (!conversation) {
      return res.status(404).json({
        error: "CONVERSATION_NOT_FOUND",
      });
    }

    return res.status(200).json(conversation);
  } catch (error) {
    if (error.code === "INVALID_RESOURCE_ID") {
      return res.status(400).json({
        error: "INVALID_CONVERSATION_ID",
      });
    }

    console.error("Error in controller updateConversationPin:", error);

    return res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = updateConversationPin;
