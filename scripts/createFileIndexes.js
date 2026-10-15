require('dotenv').config();
const mongoose = require('mongoose');
const File = require('../src/models/managedFile');
const Chunk = require('../src/models/fileChunk');
const Quota = require('../src/models/fileQuota');
(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI or MONGODB_URI required');
  await mongoose.connect(uri);
  for (const model of [File, Chunk, Quota]) await model.createIndexes();
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
