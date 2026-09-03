const { upload: ctrl } = require("../controllers");
const { auth } = require("../middlewares");
const { upload } = require("../middlewares");

const express = require("express");
const router = express.Router();

router.post("/", auth, upload.single("file"), ctrl.uploadFile);

module.exports = router;
