const { chat: ctrl } = require("../controllers");
const { auth } = require("../middlewares");

const express = require("express");
const router = express.Router();

router.post("/stream", auth, require("../controllers/chat/legacyGenerationGone"));
router.post("/preview", auth, ctrl.chatPreview);
router.get("/history", auth, ctrl.getChatHistory);

// router.post("/send", auth, ctrl.chatSend);
module.exports = router;
