const { Schema, model } = require("mongoose");

const UserSchema = Schema(
  {
    googleId: { type: String, index: true },
    email: { type: String, unique: true },
    name: { type: String },
    avatar: { type: String },

    // Billing
    appTokens: { type: Number, default: 1000 }, // 0.01$ free
    totalSpentUsd: { type: Number, default: 0 },
    // Auth
    role: {
      type: String,
      enum: ["user", "admin", "moderator", "support"],
      default: "user",
    },
    status: {
      type: String,
      enum: ["active", "blocked", "deleted"],
      default: "active",
    },
    // Sessions
    refreshToken: { type: String },
  },
  { versionKey: false, timestamps: true }
);

const User = model("user", UserSchema);

module.exports = User;
