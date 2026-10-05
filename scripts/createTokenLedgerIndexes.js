require("dotenv").config();
const mongoose = require("mongoose");
const { User, TokenTransfer, TokenOperation, BalanceOutbox } = require("../src/models");

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  await mongoose.connect(process.env.MONGO_URI);
  try {
    // Add required indexes without dropping unrelated indexes or changing balances.
    for (const model of [User, TokenTransfer, TokenOperation, BalanceOutbox]) {
      await model.createIndexes();
    }
    console.log("Token ledger and balance outbox indexes are ready.");
  } finally {
    await mongoose.disconnect();
  }
};
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
