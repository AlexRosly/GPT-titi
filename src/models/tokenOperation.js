const { Schema, model } = require("mongoose");

const Entry = new Schema({
  user: { type: Schema.Types.ObjectId, ref: "user", required: true },
  delta: { type: Number, required: true },
  balance: { type: Number, required: true },
  balanceVersion: { type: Number, required: true },
}, { _id: false });

// Immutable display context belongs to the financial operation, not a mutable chat.
const Context = new Schema({
  modelId: String,
  conversationId: { type: Schema.Types.ObjectId, ref: "chatConversation" },
  conversationTitle: String,
  messageId: { type: Schema.Types.ObjectId, ref: "chatMessage" },
  turnId: String,
  promptTokens: Number,
  completionTokens: Number,
  totalTokens: Number,
  costUsd: Number,
  paymentId: { type: Schema.Types.ObjectId, ref: "payment" },
  paymentAmountMinor: Number,
  paymentCurrency: String,
  senderEmail: String,
  recipientEmail: String,
}, { _id: false });

const schema = new Schema({
  requestSignature: { type: String, default: null },
  key: { type: String, required: true, unique: true },
  kind: { type: String, required: true },
  status: { type: String, enum: ["pending", "confirmed", "failed"], required: true },
  source: { type: String, default: "mongodb" },
  transactionHash: { type: String, default: null },
  context: { type: Context, default: null },
  entries: { type: [Entry], required: true },
}, { timestamps: true, versionKey: false });
schema.index({ "entries.user": 1, createdAt: -1 });
schema.index({ "entries.user": 1, status: 1, createdAt: -1, _id: -1 });
module.exports = model("tokenOperation", schema);
