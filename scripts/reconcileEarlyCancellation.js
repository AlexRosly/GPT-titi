// --plan targets one failed attempt. --apply requires explicit platform-cost acknowledgement.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const mongoose = require('mongoose');
(async () => {
  const [mode, value, extra, trailing] = process.argv.slice(2);
  if (trailing || !((mode === '--plan' && value && /^\d+$/.test(extra || '')) ||
      (mode === '--apply' && value && extra === '--platform-covers-unknown'))) {
    throw Object.assign(new Error('Invalid arguments'), { code: 'CANCEL_INVALID_ARGUMENTS' });
  }
  if (!process.env.CHAT_RECONCILIATION_MONGO_URI) throw new Error('Database required');
  mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.CHAT_RECONCILIATION_MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const repair = require('../src/services/chatDeliveryV2/reconcileEarlyCancellation');
  let result;
  if (mode === '--plan') result = await repair.plan({ turnId: value, attempt: Number(extra) });
  else {
    if (fs.statSync(value).size > 65536) throw new Error('Plan too large');
    result = await repair.apply(JSON.parse(fs.readFileSync(value, 'utf8')), { platformCoversUnknown: true });
  }
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  const code = typeof error.code === 'string' && /^CANCEL_[A-Z_]+$/.test(error.code) ? error.code : 'CANCEL_COMMAND_FAILED';
  console.error(JSON.stringify({ error: code,
    usage: '--plan TURN_UUID ATTEMPT OR --apply plan.json --platform-covers-unknown',
    action: 'Check database, arguments and current diagnostic. No automatic retry.' }));
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
