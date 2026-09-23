require("dotenv").config();

const mongoose = require("mongoose");
const TokenTransfer = require("../src/models/tokenTransfer");
const User = require("../src/models/user");

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  await mongoose.connect(process.env.MONGO_URI);
  try {
    // createIndexes preserves any other existing indexes.
    await TokenTransfer.createIndexes();
    await User.createIndexes();
    console.log("Token transfer indexes are ready.");
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error("Could not create token transfer indexes:", error.message);
  process.exitCode = 1;
});
