const mongoose = require("mongoose");
const { logger } = require("../utils");

const connectDB = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set in .env");
  await mongoose.connect(uri);
  logger.info("MongoDB connected");
};

module.exports = connectDB;
