module.exports = (_req, res) => res.status(410).json({
  code: "CHAT_V2_REQUIRED",
  message: "This generation endpoint has been retired. Use Chat Delivery V2.",
});
