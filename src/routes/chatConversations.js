const { chat: ctrl } = require("../controllers");
const { auth } = require("../middlewares");

const express = require("express");
const router = express.Router();

router.get("/", auth, ctrl.conversation.getConversation);
router.get("/:id/messages", auth, ctrl.conversation.getConversationMessages);
router.post("/", auth, ctrl.conversation.createConversation);
router.post(
  "/conversations/:id/regenerate",
  auth,
  ctrl.conversation.regenerateLastAnswer
);
router.post(
  "/conversations/:id/fork",
  auth,
  ctrl.conversation.forkConversation
);
router.post(
  "/messages/:id/edit-and-regenerate",
  auth,
  ctrl.messages.editUserMessageAndRegenerate
);
router.delete("/:id", auth, ctrl.conversation.archiveConversation);
router.delete(
  "/conversations/:id/messages",
  auth,
  ctrl.conversation.clearConversationMessages
);

// router.post("/send", auth, ctrl.chatSend);
module.exports = router;
