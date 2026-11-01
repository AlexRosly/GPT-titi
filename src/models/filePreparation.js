const { Schema, model } = require('mongoose');
const schema = new Schema({
  user: { type: Schema.Types.ObjectId, required: true },
  file: { type: Schema.Types.ObjectId, required: true },
  checksum: { type: String, required: true },
  modelId: { type: String, required: true },
  status: { type: String, enum: ['queued', 'running', 'ready', 'failed', 'cancelled'], default: 'queued' },
  attempts: { type: Number, default: 0 },
  leaseToken: String,
  leaseUntil: Date,
  errorCode: String,
  expiresAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });
schema.index({ user: 1, file: 1 }, { unique: true });
schema.index({ status: 1, leaseUntil: 1, createdAt: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = model('FilePreparation', schema);
