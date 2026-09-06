const { Schema, model } = require("mongoose");

const ChatProtocolErrorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
    retryable: { type: Boolean, required: true },
  },
  { _id: false },
);

const UsageSchema = new Schema(
  {
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
  },
  { _id: false },
);

const BillingSchema = new Schema(
  {
    appTokensSpent: { type: Number, required: true },
    totalTokens: { type: Number, required: true },
    balance: { type: Number, required: true },
  },
  { _id: false },
);

const ChatTurnSchema = new Schema(
  {
    turnId: { type: String, required: true, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "user", required: true, index: true },
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "chatConversation",
      required: true,
      index: true,
    },
    clientMessageId: { type: String, required: true },
    requestHash: { type: String, required: true },
    modelId: { type: String, required: true },
    message: { type: String, required: true },
    files: { type: [Schema.Types.Mixed], default: [] },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed"],
      default: "queued",
      index: true,
    },
    attempt: { type: Number, default: 1 },
    lastSeq: { type: Number, default: 0 },
    partialContent: { type: String, default: "" },
    userMessage: { type: Schema.Types.ObjectId, ref: "chatMessage", required: true },
    assistantMessage: { type: Schema.Types.ObjectId, ref: "chatMessage", default: null },
    usage: { type: UsageSchema, default: null },
    billing: { type: BillingSchema, default: null },
    billingAppliedAt: { type: Date, default: null },
    error: { type: ChatProtocolErrorSchema, default: null },
    processingStartedAt: { type: Date, default: null },
    leaseToken: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

ChatTurnSchema.index({ user: 1, clientMessageId: 1 }, { unique: true });
ChatTurnSchema.index({ status: 1, leaseUntil: 1 });
ChatTurnSchema.index({ conversation: 1, createdAt: -1 });

module.exports = model("chatTurn", ChatTurnSchema);
