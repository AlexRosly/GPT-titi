const { Schema, model } = require('mongoose');
const schema = new Schema({
  user: { type: Schema.Types.ObjectId, required: true, index: true },
  originalName: { type: String, required: true },
  mimetype: { type: String, required: true },
  size: { type: Number, required: true },
  checksum: { type: String, required: true },
  source: { type: String, enum: ['upload', 'generated'], required: true },
  status: { type: String, enum: ['ready', 'deleted'], default: 'ready' },
  retention: { type: String, enum: ['library', 'temporary'] },
  expiresAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  resultKey: String,
  derivedBytes: { type: Number, default: 0 },
  zipCache: { type: Schema.Types.Mixed, default: null },
  ocrProgress: { type: Schema.Types.Mixed, default: null },
  ocrCache: { type: Schema.Types.Mixed, default: null },
  documentEdit: { type: Schema.Types.Mixed, default: null },
  generatedPreview: { type: Schema.Types.Mixed, default: null },
  version: { type: Number, default: 1 },
}, { timestamps: true, versionKey: false });
schema.index({ user: 1, resultKey: 1 }, { unique: true, partialFilterExpression: { resultKey: { $type: 'string' } } });
schema.index({ status: 1, expiresAt: 1 });
// Owner-scoped keyset scans, including stable ordering for equal sizes/names.
schema.index({ user: 1, status: 1, _id: -1 });
schema.index({ user: 1, status: 1, size: -1, _id: -1 });
schema.index({ user: 1, status: 1, originalName: 1, _id: 1 }, { collation: { locale: 'en', strength: 2 } });
// Non-unique: previous copies and direct chat uploads must remain independent.
schema.index({ user: 1, checksum: 1, size: 1, _id: 1 },
  { partialFilterExpression: { source: 'upload', status: 'ready' } });
module.exports = model('ManagedFile', schema);
