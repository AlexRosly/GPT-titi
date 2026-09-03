const rateLimit = require("express-rate-limit");

const claimLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 5, // максимум 5 попыток
  message: "Too many requests, try later",
});

module.exports = claimLimiter;
