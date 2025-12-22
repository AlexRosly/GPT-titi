const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const authMiddleware = require("../middlewares/auth.middleware");

router.post("/google", authController.googleAuth);
router.get("/me", authMiddleware, authController.me);

module.exports = router;
