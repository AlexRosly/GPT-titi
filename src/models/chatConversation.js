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

    pinnedAt: {
      type: Date,
      default: null,
      index: true,
    },

    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
    project: {
      type: Schema.Types.ObjectId,
      ref: "project",
      default: null,
      index: true,
    },
  },
  { timestamps: true, versionKey: false },
);

ChatConversationSchema.index({
  user: 1,
  archived: 1,
  pinnedAt: -1,
  lastMessageAt: -1,
  _id: -1,
});

const ChatConversation = model("chatConversation", ChatConversationSchema);

module.exports = ChatConversation;
