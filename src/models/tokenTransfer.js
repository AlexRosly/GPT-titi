const { Schema, model } = require("mongoose");

const TokenTransferSchema = new Schema(
  {
    sender: { type: Schema.Types.ObjectId, ref: "user", required: true },
    recipient: { type: Schema.Types.ObjectId, ref: "user", required: true },
    recipientEmail: { type: String, required: true },
    clientTransferId: { type: String, required: true },
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    senderBalance: { type: Number, required: true },
  },
  { versionKey: false, timestamps: true },
);

TokenTransferSchema.index({ sender: 1, clientTransferId: 1 }, { unique: true });

module.exports = model("tokenTransfer", TokenTransferSchema);
