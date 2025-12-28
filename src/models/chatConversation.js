// models/ChatConversation.js
const { Schema, model } = require("mongoose");

const ChatConversationSchema = Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "user",
      index: true,
      required: true,
    },

    title: {
      type: String,
      default: "New chat",
    },

    modelId: {
      type: String,
      default: "gpt-4o-mini",
    },

    summary: {
      type: String,
      default: "",
    },

    archived: {
      type: Boolean,
      default: false,
    },

    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true, versionKey: false }
);

const ChatConversation = model("chatConversation", ChatConversationSchema);

module.exports = ChatConversation;
