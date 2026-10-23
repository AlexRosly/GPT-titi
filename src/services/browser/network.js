// Browser has no network namespace connectivity. This is its only byte broker.
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { normalize, fail } = require('../web/policy');
const { addressFor } = require('../web/fetch');
const { LIMITS } = require('./policy');
function request(url, record, signal) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', agent: false, signal, family: record.family, maxHeaderSize: 16384,
      lookup: (_host, options, cb) => options?.all ? cb(null, [record]) : cb(null, record.address, record.family),
      headers: { 'User-Agent': 'GPTiti-Browser/1.0', Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br' }
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        res.destroy(); return resolve({ status: res.statusCode, location: res.headers.location });
      }
      if (res.statusCode !== 200) { res.destroy(); return reject(fail('WEB_ACCESS_DENIED')); }
      if (Number(res.headers['content-length']) > LIMITS.responseBytes) { res.destroy(); return reject(fail('WEB_PAGE_TOO_LARGE')); }
      const encoding = (res.headers['content-encoding'] || 'identity').toLowerCase();
      const decoder = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[encoding]?.();
      if (!decoder && encoding !== 'identity') { res.destroy(); return reject(fail('WEB_UNSUPPORTED_ENCODING')); }
      const stream = decoder || res; let raw = 0, size = 0; const chunks = [];
      const stop = e => { res.destroy(); decoder?.destroy(); reject(e); };
      res.on('error', stop); res.on('aborted', () => stop(fail('WEB_UNAVAILABLE')));
      res.on('data', chunk => { raw += chunk.length; if (raw > LIMITS.responseBytes) stop(fail('WEB_PAGE_TOO_LARGE')); });
      stream.on('error', stop); stream.on('data', chunk => {
        size += chunk.length; if (size > LIMITS.responseBytes) stop(fail('WEB_PAGE_TOO_LARGE')); else chunks.push(chunk);
      });
      stream.on('end', () => resolve({ status: 200, type: res.headers['content-type'] || 'application/octet-stream', body: Buffer.concat(chunks) }));
      if (decoder) res.pipe(decoder);
    }); req.on('error', reject); req.end();
  });
}
function broker(seeds, parentSignal, dependencies = {}) {
  const origins = new Set(seeds.map(u => new URL(normalize(u)).origin));
  let requests = 0, bytes = 0, active = 0;
  return async message => {
    if (++requests > LIMITS.requests || active >= 8) throw fail('BROWSER_LIMIT');
    if (message.method !== 'GET' || !['document','script','stylesheet','image','font','xhr','fetch'].includes(message.resourceType)) throw fail('BROWSER_ACTION_BLOCKED');
    active++;
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal?.reason || fail('BROWSER_TIMEOUT'));
    if (parentSignal?.aborted) abort(); else parentSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(fail('WEB_TIMEOUT')), LIMITS.pageMs);
    try {
      let url = new URL(normalize(message.url));
      // Redirects are returned to Chromium so relative URLs retain correct origin.
      // Each follow-up is independently checked and pinned by this broker.
      if (message.resourceType === 'document' && !origins.has(url.origin)) throw fail('BROWSER_ACTION_BLOCKED');
      const record = await (dependencies.addressFor || addressFor)(url, controller.signal);
      const response = await (dependencies.request || request)(url, record, controller.signal);
      if (response.location !== undefined) {
        const next = normalize(new URL(response.location, url).href);
        if (message.resourceType === 'document' && !origins.has(new URL(next).origin)) throw fail('BROWSER_ACTION_BLOCKED');
        return { status: response.status, headers: { location: next }, body: '' };
      }
      bytes += response.body.length;
      if (bytes > LIMITS.bytes) throw fail('BROWSER_LIMIT');
      if (message.resourceType === 'document' && !/^text\/html(?:;|$)/i.test(response.type)) throw fail('WEB_UNSUPPORTED_TYPE');
      return { status: 200, headers: { 'content-type': response.type,
        'content-security-policy': "form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'self'",
        'referrer-policy': 'no-referrer' }, body: response.body.toString('base64') };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally { active--; clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); }
  };
}
module.exports = { broker, request };
