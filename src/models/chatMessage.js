// const { Schema, model } = require("mongoose");

// const ChatMessageSchema = Schema(
//   {
//     user: {
//       type: Schema.Types.ObjectId,
//       ref: "user",
//       required: true,
//       index: true,
//     },

//     // 🔗 связь с диалогом
//     conversation: {
//       type: Schema.Types.ObjectId,
//       ref: "chatConversation",
//       required: true,
//       index: true,
//     },

//     role: {
//       type: String,
//       enum: ["user", "assistant", "system"],
//       required: true,
//     },

//     content: {
//       type: String,
//       required: true,
//     },

//     modelId: {
//       type: String,
//     },
//     // 🔢 токены конкретного сообщения
//     tokens: {
//       type: Number,
//       default: 0,
//     },
//     // 💰 биллинг-мета
//     meta: {
//       appTokens: { type: Number },
//       costUsd: { type: Number },
//     },

//     // 🧹 soft delete
//     deleted: {
//       type: Date,
//       default: null,
//       index: true,
//     },
//     attachments: [
//       {
//         filename: { type: String },
//         originalName: { type: String },
//         mimetype: { type: String },
//         size: { type: Number },
//         url: { type: String },
//         expiresAt: { type: Date },
//         deletedAt: { type: Date },
//       },
//     ],
//   },
//   {
//     timestamps: true,
//   },
// );

// ChatMessageSchema.index({ conversation: 1, deleted: 1, createdAt: -1 });

// const ChatMessage = model("chatMessage", ChatMessageSchema);

// module.exports = ChatMessage;
const { Schema, model } = require("mongoose");

const ChatMessageSchema = new Schema(
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
      appTokens: {
        type: Number,
      },

      costUsd: {
        type: Number,
      },
    },

    // =========================================================
    // Chat Delivery Protocol v2
    // =========================================================

    // Идентификатор durable turn.
    //
    // Legacy messages:
    //   turnId === null
    //
    // Delivery v2:
    //   turnId === UUID/string
    turnId: {
      type: String,
      default: null,
      index: true,
    },

    // Client idempotency key.
    //
    // Legacy messages:
    //   clientMessageId === null
    //
    // Delivery v2 user message:
    //   UUID v4
    clientMessageId: {
      type: String,
      default: null,
    },

    // Attempt конкретного turn.
    //
    // Legacy messages:
    //   attempt === null
    //
    // Delivery v2:
    //   1, 2, 3, ...
    attempt: {
      type: Number,
      default: null,
    },

    // =========================================================
    // Soft delete
    // =========================================================

    deleted: {
      type: Date,
      default: null,
      index: true,
    },

    // =========================================================
    // Attachments
    // =========================================================

    attachments: [
      {
        filename: {
          type: String,
        },

        originalName: {
          type: String,
        },

        mimetype: {
          type: String,
        },

        size: {
          type: Number,
        },

        url: {
          type: String,
        },

        expiresAt: {
          type: Date,
        },

        deletedAt: {
          type: Date,
        },
      },
    ],
  },
  {
    timestamps: true,
  },
);

// =============================================================
// Existing message history index
// =============================================================

ChatMessageSchema.index(
  {
    conversation: 1,
    deleted: 1,
    createdAt: -1,
  },
  {
    name: "chatMessage_conversation_deleted_createdAt",
  },
);

// =============================================================
// Chat Delivery Protocol v2
//
// Legacy messages have turnId === null and therefore do NOT
// participate in these unique indexes.
//
// This guarantees:
//
// 1. only one v2 user message per turn
// 2. only one v2 assistant message per turn
//
// User and assistant messages can therefore share the same
// turnId, while duplicate messages of the same role cannot.
//
// =============================================================

ChatMessageSchema.index(
  {
    turnId: 1,
  },
  {
    unique: true,
    name: "chatMessage_v2_user_turn_unique",
    partialFilterExpression: {
      turnId: {
        $type: "string",
      },
      role: "user",
    },
  },
);

ChatMessageSchema.index(
  {
    turnId: 1,
  },
  {
    unique: true,
    name: "chatMessage_v2_assistant_turn_unique",
    partialFilterExpression: {
      turnId: {
        $type: "string",
      },
      role: "assistant",
    },
  },
);

// =============================================================
// MODEL
// =============================================================

const ChatMessage = model("chatMessage", ChatMessageSchema);

module.exports = ChatMessage;
