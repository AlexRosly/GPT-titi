const router = require("express").Router();

router.get("/health", (req, res) => res.status(200).json({ ok: true }));

module.exports = router;
