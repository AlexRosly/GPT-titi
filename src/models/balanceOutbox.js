const { Schema, model } = require("mongoose");

const schema = new Schema({
  operation: { type: Schema.Types.ObjectId, ref: "tokenOperation", required: true },
  user: { type: Schema.Types.ObjectId, ref: "user", required: true },
  balanceVersion: { type: Number, required: true },
  reason: { type: String, required: true },
  deliveredAt: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: () => new Date() },
  leaseUntil: { type: Date, default: null },
  leaseToken: { type: String, default: null },
  attempts: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });
schema.index({ operation: 1, user: 1 }, { unique: true });
schema.index({ deliveredAt: 1, nextAttemptAt: 1, leaseUntil: 1 });
module.exports = model("balanceOutbox", schema);
