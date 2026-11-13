// Read-only default: --plan targets.json. Mutation: --apply previously saved plan.json.
// Only the supplied attempts are considered; there is no broad account reset.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const mongoose = require('mongoose');
(async () => {
  const [mode, filename, extra] = process.argv.slice(2);
  if (!['--plan', '--apply'].includes(mode) || !filename || extra) throw new Error('Use --plan targets.json OR --apply plan.json');
  if (!process.env.CHAT_RECONCILIATION_MONGO_URI) throw new Error('Set CHAT_RECONCILIATION_MONGO_URI to the intended database');
  if (fs.statSync(filename).size > 65536) throw new Error('Input must not exceed 64 KiB');
  const input = JSON.parse(fs.readFileSync(filename, 'utf8'));
  // In particular --plan must not build indexes or create collections.
  mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
  const repair = require('../src/services/chatDeliveryV2/reconcileStoppedDocuments');
  await mongoose.connect(process.env.CHAT_RECONCILIATION_MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const result = mode === '--plan' ? await repair.plan(input.turns) : await repair.apply(input);
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  // Never echo connection strings, raw provider messages, request text or secrets.
  const safe = typeof error.code === 'string' && /^REPAIR_[A-Z_]+$/.test(error.code) ? error.code : 'REPAIR_COMMAND_FAILED';
  console.error(JSON.stringify({ error: safe, action: 'No automatic retry. Check arguments, database configuration and current diagnostic.' }));
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
