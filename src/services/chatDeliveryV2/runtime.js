// Captured when loaded by this process, never inferred from files on disk by
// the diagnostic CLI. The revision identifies the handoff guard implementation.
module.exports = Object.freeze({
  revision: 'document-testing-limits-v2',
  bootId: require('node:crypto').randomUUID(),
  loadedAt: new Date().toISOString(),
  pid: process.pid,
  pm2Id: /^\d{1,6}$/.test(process.env.pm_id || '') ? Number(process.env.pm_id) : null,
  // Read the live process environment at the persistence/logging boundary.
  get computeLimits() { return require('../computation/config').limits(); },
});
