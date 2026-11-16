// Preview by default. --apply=PLAN replays exactly the saved whole-file selection.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const cleanup = require('../src/services/files/developmentCleanup');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const mib = bytes => Number((bytes / 1024 ** 2).toFixed(2));

async function main() {
  if (process.argv.slice(2).some(value => !/^--(?:database|fraction|apply|verify)=.+$/.test(value))) throw Error('Usage: node scripts/cleanupDevelopmentFiles.js --database=NAME [--fraction=0.5 | --apply=PLAN.json | --verify=PLAN.json]');
  if (option('apply') && option('verify')) throw Error('--apply cannot be combined with --verify.');
  const database = option('database');
  if (!database || ['admin', 'config', 'local'].includes(database) || /[/\\\s]/.test(database)) throw Error('Specify the exact disposable development database with --database=NAME.');
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw Error('MONGO_URI or MONGODB_URI required.');
  await mongoose.connect(uri, { dbName: database, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 15000 });
  const clientOptions = mongoose.connection.getClient().options;
  const target = { database: mongoose.connection.name, host: clientOptions.srvHost || clientOptions.hosts.map(host => host.toString()).sort().join(',') };
  console.log(JSON.stringify({ connected: true, ...target }));
  if (option('apply') || option('verify')) {
    if (option('fraction')) throw Error('--fraction cannot be combined with --apply.');
    const plan = JSON.parse(fs.readFileSync(option('apply') || option('verify'), 'utf8'));
    if (plan.database !== target.database || plan.host !== target.host) throw Error('Cleanup plan belongs to a different database or cluster.');
    if (option('verify')) {
      const result = await cleanup.verify(plan);
      console.log(JSON.stringify({ mode: 'verify', ...target, ...result, remainingChunkMiB: mib(result.remainingChunkBytes) }, null, 2));
      if (result.selectedTombstones !== result.selectedFiles || result.remainingSelectedChunks || result.quotaMismatches.length) process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify({ mode: 'apply', ...target, selectedFiles: plan.files.length, selectedMiB: mib(plan.selectedBytes) }));
    const result = await cleanup.apply(plan, value => console.log(JSON.stringify(value)));
    console.log(JSON.stringify({ ...result, deletedChunkMiB: mib(result.deletedChunkBytes) }));
    return;
  }
  const plan = { ...target, createdAt: new Date().toISOString(), ...await cleanup.inventory(Number(option('fraction') || 0.5)) };
  const directory = path.resolve('backups/file-cleanup');
  fs.mkdirSync(directory, { recursive: true });
  const planFile = path.join(directory, `plan-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ mode: 'preview', ...target, chunkMiB: mib(plan.totalBytes), targetMiB: mib(plan.targetBytes),
    selectedMiB: mib(plan.selectedBytes), selectedFiles: plan.files.length, readyFiles: plan.readyFiles,
    selectedChunks: plan.selectedChunks, totalChunks: plan.totalChunks, targetReached: plan.targetReached,
    unlinkedChunks: plan.unlinked.reduce((sum, row) => sum + row.chunks, 0), planFile }, null, 2));
  console.table(plan.files.map(file => ({ fileId: file.fileId, name: file.name, MiB: mib(file.chunkBytes), chunks: file.chunks })));
  console.log('Preview only. The JSON is a deletion manifest, not a backup of file contents.');
  console.log(`Apply this exact selection: node scripts/cleanupDevelopmentFiles.js --database=${database} --apply="${planFile}"`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
