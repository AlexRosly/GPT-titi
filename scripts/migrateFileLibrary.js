require('dotenv').config();
const mongoose = require('mongoose');
const { migrate } = require('../src/services/files/libraryMigration');
(async () => {
  const args = process.argv.slice(2);
  if (args.some(a => !['--apply', '--repair-quota'].includes(a))) throw Error('Usage: node scripts/migrateFileLibrary.js [--apply [--repair-quota]]');
  const apply = args.includes('--apply');
  if (apply && process.env.FILE_LIBRARY_MIGRATION_OFFLINE !== 'yes') throw Error('Stop ALL API, cleanup and preparation workers, then set FILE_LIBRARY_MIGRATION_OFFLINE=yes for --apply.');
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw Error('MONGO_URI or MONGODB_URI required');
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const report = await migrate({ apply, repairQuota: args.includes('--repair-quota') });
  console.log(JSON.stringify(report, null, 2));
  if (report.problems.length) process.exitCode = 2;
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
