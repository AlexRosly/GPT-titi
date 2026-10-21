const { normalize, fail } = require('../web/policy');
const LIMITS = Object.freeze({ actions: 4, calls: 5, durationMs: 180000, pageMs: 15000,
  textBytes: 8192, controls: 50, requests: 120, bytes: 16 * 1024 * 1024, responseBytes: 2 * 1024 * 1024 });
const enabled = model => process.env.BROWSER_V2_ENABLED === 'true' && model?.browserInputEnabled !== false;
function action(value, observation, seeds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('BROWSER_INVALID_ACTION');
  const { kind, ref, query, url } = value;
  const keys = { open: ['kind','url'], follow: ['kind','ref'], expand: ['kind','ref'], tab: ['kind','ref'], search: ['kind','ref','query'], scroll: ['kind'], back: ['kind'], done: ['kind'] }[kind];
  if (!keys || Object.keys(value).some(k => !keys.includes(k))) throw fail('BROWSER_INVALID_ACTION');
  if (kind === 'open') {
    if (!seeds.includes(normalize(url))) throw fail('BROWSER_ACTION_BLOCKED');
  } else if (['follow','expand','tab','search'].includes(kind)) {
    const control = observation?.controls?.find(c => c.ref === ref && c.kind === kind);
    if (!control) throw fail('BROWSER_ACTION_BLOCKED');
    if (kind === 'search' && (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\x00-\x1f]/.test(query))) throw fail('BROWSER_INVALID_ACTION');
  }
  return value;
}
module.exports = { LIMITS, enabled, action };
