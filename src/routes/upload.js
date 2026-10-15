const { upload: ctrl } = require("../controllers");
const { auth } = require("../middlewares");
const { upload } = require("../middlewares");
const multer = require("multer");
const path = require("path");
const os = require("os");

const express = require("express");
const router = express.Router();

router.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/" && require("../services/files/config").enabled()) {
    return require("./files")(req, res, next);
  }
  next();
});
router.post("/", auth, upload.single("file"), ctrl.uploadFile);
const transcriptionUpload = multer({
  storage: multer.diskStorage({
    destination: (_, __, callback) => callback(null, os.tmpdir()),
    filename: (_, file, callback) =>
      callback(
        null,
        `gpt-titi-audio-${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(file.originalname || "")}`,
      ),
  }),
  limits: {
    fileSize: Number(process.env.TRANSCRIPTION_MAX_FILE_SIZE || 25 * 1024 * 1024),
  },
});

router.post("/transcriptions", auth, (req, res, next) => {
  transcriptionUpload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Audio file is too large" });
    }
    if (err) return next(err);
    next();
  });
}, ctrl.transcribeAudio);

module.exports = router;
