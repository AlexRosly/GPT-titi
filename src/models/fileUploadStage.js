const {Schema, model} = require('mongoose');

// The cleanup worker removes the chunks before removing this marker. A TTL
// index would erase the only durable reference after an interrupted upload.
const schema = new Schema({
  expiresAt: {type:Date, required:true, index:true},
  cleaning: {type:Boolean, default:false},
}, {versionKey:false});
module.exports = model('FileUploadStage', schema);
