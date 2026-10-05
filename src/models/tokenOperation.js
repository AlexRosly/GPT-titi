const { Schema, model } = require("mongoose");

const Entry = new Schema({
  user: { type: Schema.Types.ObjectId, ref: "user", required: true },
  delta: { type: Number, required: true },
  balance: { type: Number, required: true },
  balanceVersion: { type: Number, required: true },
}, { _id: false });

const schema = new Schema({
  requestSignature: { type: String, default: null },
  key: { type: String, required: true, unique: true },
  kind: { type: String, required: true },
  status: { type: String, enum: ["pending", "confirmed", "failed"], required: true },
  source: { type: String, default: "mongodb" },
  transactionHash: { type: String, default: null },
  entries: { type: [Entry], required: true },
}, { timestamps: true, versionKey: false });
schema.index({ "entries.user": 1, createdAt: -1 });
module.exports = model("tokenOperation", schema);
