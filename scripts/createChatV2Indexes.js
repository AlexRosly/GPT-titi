// require("dotenv").config();
// const connectDB = require("../src/config/db");
// const { ChatTurn, ChatBillingLedger, ChatMessage } = require("../src/models");

// (async () => {
//   try {
//     await connectDB();
//     await Promise.all([
//       ChatTurn.createIndexes(),
//       ChatBillingLedger.createIndexes(),
//       ChatMessage.createIndexes(),
//     ]);
//     console.log("Chat Delivery Protocol v2 indexes created.");
//     process.exit(0);
//   } catch (error) {
//     console.error("Failed to create chat v2 indexes:", error);
//     process.exit(1);
//   }
// })();
require("dotenv").config();

const mongoose = require("mongoose");

const connectDB = require("../src/config/db");

const { ChatTurn, ChatBillingLedger } = require("../src/models");

const createChatV2Indexes = async () => {
  try {
    // =========================================================
    // CONNECT
    // =========================================================

    await connectDB();

    // =========================================================
    // CHAT DELIVERY PROTOCOL V2 INDEXES
    // =========================================================

    await Promise.all([
      ChatTurn.createIndexes(),
      ChatBillingLedger.createIndexes(),
    ]);

    console.log("Chat Delivery Protocol v2 indexes created.");
  } catch (error) {
    console.error("Failed to create Chat Delivery Protocol v2 indexes:", error);

    process.exitCode = 1;
  } finally {
    // =========================================================
    // DISCONNECT
    // =========================================================

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
};

createChatV2Indexes();
