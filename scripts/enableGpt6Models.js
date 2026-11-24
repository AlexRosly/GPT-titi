require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const ChatModels = require('../src/models/chatModels');
const activation = require('../src/config/gpt6Activation');

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw Error('Usage: node scripts/enableGpt6Models.js [--apply]');
  if (!process.env.MONGO_URI) throw Error('MONGO_URI is required.');
  await mongoose.connect(process.env.MONGO_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
  const filter = { modelId: { $in: activation.models.map(model => model.modelId) } };
  const existing = await ChatModels.find(filter).lean();
  const operations = activation.plan(existing);
  console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'preview', database: mongoose.connection.name,
    changes: operations.map(op => ({ modelId: op.updateOne.filter.modelId, ...op.updateOne.update.$set })) }, null, 2));
  if (!args.includes('--apply')) { console.log('Preview only. --apply enables these six models and fills missing prices.'); return; }
  const session = await mongoose.startSession();
  let backupFile;
  try {
    await session.withTransaction(async () => {
      const current = await ChatModels.find(filter).session(session).lean();
      const updates = activation.plan(current);
      const directory = path.resolve('backups/model-catalog'); fs.mkdirSync(directory, { recursive: true });
      backupFile = path.join(directory, `before-gpt6-activation-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
      fs.writeFileSync(backupFile, JSON.stringify({ database: mongoose.connection.name, host: mongoose.connection.host,
        targetIds: activation.models.map(model => model.modelId), records: current }, null, 2), { flag: 'wx', mode: 0o600 });
      await ChatModels.bulkWrite(updates, { session, ordered: true });
    });
  } finally { await session.endSession(); }
  const saved = await ChatModels.find(filter).select('modelId enabled apiMode reasoningEffort inputPerM outputPerM').lean();
  if (saved.length !== activation.models.length || saved.some(model => model.enabled !== true || model.apiMode !== 'responses')) throw Error('Activation verification failed.');
  console.log(JSON.stringify({ success: true, models: saved, backupFile }, null, 2));
}
main().catch(error => { console.error(error.name?.startsWith('Mongo') ? `MongoDB operation failed (${error.codeName || error.code || error.name}).` : error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
