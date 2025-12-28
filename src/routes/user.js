const { user: ctrl } = require("../controllers");
const { auth } = require("../middlewares");

const express = require("express");
const router = express.Router();

router.post("/user", ctrl.createUser); //Google Login / Register
router.post("/refresh", ctrl.refreshToken); // auth POST /auth/refresh
router.get("/logout", ctrl.logout); //auth //
router.get("/usage/summary", auth, ctrl.tokenUsage);
router.get("/usage/history", auth, ctrl.getUsageHistory); ///usage/history?days=7 change day

module.exports = router;
