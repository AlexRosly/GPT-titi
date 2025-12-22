const { user: ctrl } = require("../controllers");
// const { authAdmin, validation, ctrlWrapper } = require("../../middlewares");
const express = require("express");
const router = express.Router();

router.post("/user", ctrl.createUser);
router.post("/refresh", ctrl.refreshToken);
router.get("/logout", ctrl.logout);

module.exports = router;
