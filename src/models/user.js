const { Schema, model } = require("mongoose");

const UserSchema = Schema(
  {
    googleId: { type: String, index: true },
    email: { type: String, unique: true },
    name: { type: String },
    avatar: { type: String },

    // Billing
    appTokens: { type: Number, default: 10000 }, // 0.01$ free
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
    dateClaimToken: { type: Date },
    nextDateClaimToken: { type: Date },
    // Sessions
    refreshToken: { type: String },
  },
  { versionKey: false, timestamps: true },
);

// Recipient lookups are case-insensitive, including for existing mixed-case emails.
UserSchema.index(
  { email: 1 },
  { name: "email_case_insensitive", collation: { locale: "en", strength: 2 } },
);

const User = model("user", UserSchema);

module.exports = User;
