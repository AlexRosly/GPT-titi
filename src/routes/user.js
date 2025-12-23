const { user: ctrl } = require("../controllers");
const auth = require("../middlewares/auth");

const express = require("express");
const router = express.Router();

router.post("/user", ctrl.createUser);
router.post("/refresh", ctrl.refreshToken);
router.get("/logout", ctrl.logout);
router.get("/usage/summary", auth, ctrl.tokenUsage);
router.get("/usage/history", auth, ctrl.getUsageHistory); ///usage/history?days=7 change day

module.exports = router;
