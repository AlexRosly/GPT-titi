// Usage: node scripts/reconcileChatReservation.js /secure/path/resolution.json
// JSON: {turnId, attempt, reason, noCharge:true} OR {turnId, attempt, reason,
// usage:{prompt_tokens,completion_tokens,total_tokens}}. Provider evidence only.
require("dotenv").config();
const fs = require("node:fs");
const mongoose = require("mongoose");
const reconcile = require("../src/services/chatDeliveryV2/reconcileReservation");
(async () => {
  if (!process.env.CHAT_RECONCILIATION_MONGO_URI || !process.argv[2]) {
    throw new Error("Set CHAT_RECONCILIATION_MONGO_URI and provide a resolution JSON file.");
  }
  const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  await mongoose.connect(process.env.CHAT_RECONCILIATION_MONGO_URI);
  console.log(await reconcile(input));
})().catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
