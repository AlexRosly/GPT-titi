const LIMITS = Object.freeze({ actions: 4, calls: 5, durationMs: 180000, pageMs: 15000,
  textBytes: 8192, controls: 50, requests: 120, bytes: 16 * 1024 * 1024, responseBytes: 2 * 1024 * 1024 });
const enabled = model => process.env.BROWSER_V2_ENABLED === 'true' && model?.browserInputEnabled !== false;
function action(value, observation, seeds) {
  return require('./actions').validate(value, observation, seeds).action;
}
module.exports = { LIMITS, enabled, action };
