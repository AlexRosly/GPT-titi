const { Schema, model } = require("mongoose");

const ChatBillingLedgerSchema = new Schema(
  {
    turnId: { type: String, required: true, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "user", required: true, index: true },
    modelId: { type: String, required: true },
    appTokensSpent: { type: Number, required: true },
    totalTokens: { type: Number, required: true },
    usd: { type: Number, required: true },
    balance: { type: Number, required: true },
  },
  { timestamps: true, versionKey: false },
);

module.exports = model("chatBillingLedger", ChatBillingLedgerSchema);
