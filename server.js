require("dotenv").config();
const app = require("./src/app");
const { logger } = require("./src/utils");
const connectDB = require("./src/config/db");

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      logger.info("Server started on port " + PORT);
    });
  })
  .catch((err) => {
    logger.error("Failed to start", err);
    process.exit(1);
  });
