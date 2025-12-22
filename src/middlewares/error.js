const { logger } = require("../utils");

const errorMiddleware = (err, req, res, next) => {
  logger.error(err);
  const status = err.status || 500;
  res.status(status).json({ message: err.message || "Internal server error" });
};

module.exports = errorMiddleware;
