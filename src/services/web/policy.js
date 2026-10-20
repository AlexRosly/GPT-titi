const ipaddr = require('ipaddr.js');
const { errorFor } = require('../chatDeliveryV2/protocol');
const MAX_URLS = 3, PAGE_BYTES = 12 * 1024, WEB_ALLOWANCE = 64 * 1024, OUTPUT_TOKENS = 8192;
const fail = code => Object.assign(new Error(code), { webError: code, protocolError: errorFor(code) });
const enabled = model => process.env.WEB_READING_ENABLED !== 'false' && model?.webInputEnabled !== false;
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
function urlsIn(message) {
  const urls = [];
  for (const match of String(message).matchAll(/https?:\/\/[^\s<>"`]+/giu)) {
    let raw = match[0].replace(/[.,;!?]+$/, '');
    while ((raw.endsWith(')') && (raw.match(/\)/g)||[]).length > (raw.match(/\(/g)||[]).length) || raw.endsWith(']')) raw = raw.slice(0,-1);
    // Preserve invalid candidates so the caller can disclose an error when selected.
    if (!urls.includes(raw)) urls.push(raw);
  }
  return urls;
}
function plan(message, model, history, textBudget) {
  if (!enabled(model)) return null;
  const urls = urlsIn(message);
  if (!urls.length) return null;
  if (urls.length > MAX_URLS) throw fail('WEB_TOO_MANY_URLS');
  if (urls.some(u => u.length > 2048)) throw fail('WEB_INVALID_URL');
  const historyBytes = Buffer.byteLength(JSON.stringify(history.map(m => ({ role:m.role, content:m.content || '' }))));
  const images = history.flatMap(m => m.attachments || []).filter(f => /^image\//.test(f.mimetype || '')).length;
  // Bytes are a conservative text token bound, not chars/4. Image allowance is
  // checked again on the actual provider content. Reserve both bounded calls.
  const inputLimit = 32768 + historyBytes + (textBudget?.promptBytes || 0) * 2 + images * 32768 + WEB_ALLOWANCE;
  if (inputLimit > 262144) throw fail('WEB_CONTEXT_TOO_LARGE');
  return { urls, inputLimit, outputLimit: OUTPUT_TOKENS };
}
function reservation(plan, pricing, tokenValue) {
  if (!plan) return 0;
  if (![pricing.inputPerM, pricing.outputPerM, tokenValue].every(Number.isFinite) || pricing.inputPerM < 0 || pricing.outputPerM < 0 || tokenValue <= 0) throw fail('WEB_CONFIGURATION_ERROR');
  return Math.ceil((2 * plan.inputLimit * pricing.inputPerM + 2 * plan.outputLimit * pricing.outputPerM) / 1e6 / tokenValue);
}
function inputBound(messages, tools) {
  let images = 0;
  const normalized = messages.map(m => ({ ...m, content: Array.isArray(m.content) ? m.content.map(p => {
    if (p.type === 'image_url') { images++; return { type:'image_url' }; } return p;
  }) : m.content }));
  return Buffer.byteLength(JSON.stringify({ messages:normalized, tools })) + images * 32768 + messages.length * 32;
}
module.exports = { MAX_URLS, PAGE_BYTES, WEB_ALLOWANCE, OUTPUT_TOKENS, fail, enabled, normalize, publicAddress, urlsIn, plan, reservation, inputBound };
