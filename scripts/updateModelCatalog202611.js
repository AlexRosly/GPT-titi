require('dotenv').config();
const mongoose = require('mongoose');
const ChatModels = require('../src/models/chatModels');
const catalog = require('../src/config/modelCatalog202611');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  if (!process.env.MONGO_URI) throw Error('MONGO_URI is required.');
  await mongoose.connect(process.env.MONGO_URI);
  const restore = process.argv.find(value => value.startsWith('--restore='))?.slice('--restore='.length);
  if (restore) {
    const backup = JSON.parse(fs.readFileSync(restore, 'utf8'));
    if (backup.database !== mongoose.connection.name || backup.host !== mongoose.connection.host || !Array.isArray(backup.records)) throw Error('Backup does not belong to this database.');
    const known = id => catalog.retired.test(id) || catalog.additions.some(m => m.modelId === id);
    if (backup.records.some(m => !known(m.modelId))) throw Error('Unexpected model in backup.');
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        for (const row of backup.records) {
          const doc = { ...row, _id: new mongoose.Types.ObjectId(row._id) };
          for (const key of ['createdAt', 'updatedAt']) if (doc[key]) doc[key] = new Date(doc[key]);
          await ChatModels.collection.replaceOne({ modelId: row.modelId }, doc, { session });
        }
        const inserted = catalog.additions.map(m => m.modelId).filter(id => !backup.records.some(m => m.modelId === id));
        await ChatModels.updateMany({ modelId: { $in: inserted } }, { $set: { enabled: false } }, { session });
      });
    } finally { await session.endSession(); }
    console.log('Previous model configuration restored. Draft entries created by the migration remain disabled.');
    return;
  }
  const existing = await ChatModels.find({}).select('modelId label enabled default apiMode reasoningEffort').lean();
  const operations = catalog.plan(existing);
  console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'preview',
    retained: catalog.retained, operations }, null, 2));
  if (!process.argv.includes('--apply')) {
    console.log('Preview only. Use --apply to disable the listed old models and create disabled Responses entries.');
    return;
  }
  const session = await mongoose.startSession();
  let backupFile;
  try {
    await session.withTransaction(async () => {
      const current = await ChatModels.find({}).session(session).lean();
      const updates = catalog.plan(current);
      const directory = path.resolve('backups/model-catalog');
      fs.mkdirSync(directory, { recursive: true });
      backupFile = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`);
      fs.writeFileSync(backupFile, JSON.stringify({ database: mongoose.connection.name, host: mongoose.connection.host,
        records: current.filter(m => catalog.retired.test(m.modelId) || catalog.additions.some(n => n.modelId === m.modelId)) }, null, 2), { flag: 'wx' });
      if (updates.length) await ChatModels.bulkWrite(updates, { ordered: true, session });
    });
  } finally { await session.endSession(); }
  console.log(`Rollback backup: ${backupFile}`);
  console.log('Catalog updated. History and conversations were preserved. New models remain disabled; prices and release verification must be supplied before activation.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
