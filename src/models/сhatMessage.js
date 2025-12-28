const { Schema, model } = require("mongoose");

const ChatMessageSchema = Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
      index: true,
    },

    // 🔗 связь с диалогом
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "chatConversation",
      required: true,
      index: true,
    },

    role: {
      type: String,
      enum: ["user", "assistant", "system"],
      required: true,
    },

    content: {
      type: String,
      required: true,
    },

    modelId: {
      type: String,
    },
    // 🔢 токены конкретного сообщения
    tokens: {
      type: Number,
      default: 0,
    },
    // 💰 биллинг-мета
    meta: {
      appTokens: { type: Number },
      costUsd: { type: Number },
    },

    // 🧹 soft delete
    deleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

ChatMessageSchema.index({ conversation: 1, createdAt: -1 });

const ChatMessage = model("chatMessage", ChatMessageSchema);

module.exports = ChatMessage;
