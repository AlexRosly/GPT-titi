const { Schema, model } = require('mongoose');
const schema = new Schema({
  file: { type: Schema.Types.ObjectId, required: true },
  index: { type: Number, required: true },
  data: { type: Buffer, required: true },
}, { versionKey: false });
schema.index({ file: 1, index: 1 }, { unique: true });
module.exports = model('FileChunk', schema);
