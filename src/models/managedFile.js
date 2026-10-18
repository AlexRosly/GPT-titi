const { Schema, model } = require('mongoose');
const schema = new Schema({
  user: { type: Schema.Types.ObjectId, required: true, index: true },
  originalName: { type: String, required: true },
  mimetype: { type: String, required: true },
  size: { type: Number, required: true },
  checksum: { type: String, required: true },
  source: { type: String, enum: ['upload', 'generated'], required: true },
  status: { type: String, enum: ['ready', 'deleted'], default: 'ready' },
  expiresAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  resultKey: String,
  derivedBytes: { type: Number, default: 0 },
  ocrCache: { type: Schema.Types.Mixed, default: null },
  generatedPreview: { type: Schema.Types.Mixed, default: null },
  version: { type: Number, default: 1 },
}, { timestamps: true, versionKey: false });
schema.index({ user: 1, resultKey: 1 }, { unique: true, partialFilterExpression: { resultKey: { $type: 'string' } } });
schema.index({ status: 1, expiresAt: 1 });
module.exports = model('ManagedFile', schema);
