import pinoHttp from "pino-http";
import logger from "../utils/logger.js";

export default pinoHttp({
  logger,
  customLogLevel(res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
});
