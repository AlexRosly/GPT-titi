const ipaddr = require('ipaddr.js');
const { directUrls, urlsIn } = require('./readTargets');
const { errorFor } = require('../chatDeliveryV2/protocol');
const MAX_URLS = 3, PAGE_BYTES = 12 * 1024, OUTPUT_TOKENS = 4096;
const fail = code => Object.assign(new Error(code), { webError: code, protocolError: errorFor(code) });
const enabled = model => process.env.WEB_READING_V2_ENABLED === 'true' && model?.webInputEnabled !== false;
function normalize(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/u.test(value)) throw fail('WEB_INVALID_URL');
  let url; try { url = new URL(value); } catch { throw fail('WEB_INVALID_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw fail('WEB_INVALID_URL');
  url.hash = ''; url.hostname = url.hostname.replace(/\.$/, '');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || /(^|\.)(localhost|local|internal|lan|home|test|invalid|onion)$/.test(host) || (!host.includes('.') && !host.includes(':'))) throw fail('WEB_BLOCKED_ADDRESS');
  if (ipaddr.isValid(host) && !publicAddress(host)) throw fail('WEB_BLOCKED_ADDRESS');
  return url.href;
}
function publicAddress(value) {
  try { if (value === '168.63.129.16') return false; const ip = ipaddr.parse(value); return ip.range() === 'unicast' && !(ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()); } catch { return false; }
}
function plan(message, model) {
  if (!enabled(model)) return null;
  const urls = directUrls(message);
  if (!urls.length) return null;
  const targets = [...new Set(urls.map(normalize))];
  if (targets.length > MAX_URLS) throw fail('WEB_TOO_MANY_URLS');
  return { version: 3, urls: targets };
}
module.exports = { MAX_URLS, PAGE_BYTES, OUTPUT_TOKENS, fail, enabled, normalize, publicAddress, urlsIn, plan };
