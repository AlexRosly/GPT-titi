const { Schema, model } = require('mongoose');
module.exports = model('FileQuota', new Schema({
  _id: { type: Schema.Types.ObjectId },
  bytes: { type: Number, default: 0 },
  count: { type: Number, default: 0 },
}, { versionKey: false }));
