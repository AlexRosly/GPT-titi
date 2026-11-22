require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const ChatModels = require('../src/models/chatModels');
const catalog = require('../src/config/modelCatalog20261122');

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw Error('Usage: node scripts/addGpt62Models.js [--apply]');
  if (!process.env.MONGO_URI) throw Error('MONGO_URI is required.');
  await mongoose.connect(process.env.MONGO_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
  const filter = { modelId: { $in: catalog.additions.map(model => model.modelId) } };
  const existing = await ChatModels.find(filter).lean();
  const operations = catalog.plan(existing);
  console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'preview', database: mongoose.connection.name,
    models: catalog.additions.map(model => ({ ...model, enabled: false, exists: existing.some(row => row.modelId === model.modelId) })),
    insertCount: operations.length }, null, 2));
  if (!args.includes('--apply')) {
    console.log('Preview only. Use --apply to insert the missing disabled GPT-6.2 models.');
    return;
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await ChatModels.find(filter).session(session).lean();
      const updates = catalog.plan(current);
      if (updates.length) await ChatModels.bulkWrite(updates, { session, ordered: true });
    });
  } finally { await session.endSession(); }
  const saved = await ChatModels.find(filter).select('modelId label enabled default apiMode reasoningEffort').lean();
  if (saved.length !== catalog.additions.length || saved.some(model => model.enabled !== false)) throw Error('GPT-6.2 draft verification failed.');
  console.log(JSON.stringify({ success: true, models: saved }, null, 2));
  console.log('GPT-6.2 drafts are present and disabled. Existing models and prices were preserved.');
}
main().catch(error => {
  console.error(error.name?.startsWith('Mongo') ? `MongoDB operation failed (${error.codeName || error.code || error.name}).` : error.message);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
