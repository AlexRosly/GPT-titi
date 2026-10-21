const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const net = require('node:net');
const { normalize, publicAddress, fail } = require('./policy');
const html = require('./html');
const MAX_BYTES = 2 * 1024 * 1024, TIMEOUT_MS = 15000;
async function addressFor(url, signal) {
  const host = url.hostname.replace(/^\[|\]$/g,'');
  if (signal.aborted) throw signal.reason;
  let records;
  if (net.isIP(host)) records = [{address:host, family:net.isIP(host)}];
  else records = await new Promise((resolve,reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    dns.lookup(host,{all:true,verbatim:true}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
  if (!records.length || records.some(r=>!publicAddress(r.address))) throw fail('WEB_BLOCKED_ADDRESS');
  return records[0];
}
function request(url, record, signal) {
  return new Promise((resolve,reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method:'GET', agent:false, signal, family:record.family,
      lookup: (_host, options, callback) => options?.all ? callback(null,[record]) : callback(null,record.address,record.family),
      maxHeaderSize:16384,
      headers:{ 'User-Agent':'GPTiti-WebReader/1.0', Accept:'text/html', 'Accept-Encoding':'gzip, deflate, br' },
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) { const location=res.headers.location; res.destroy(); resolve({location}); return; }
      if (res.statusCode !== 200) { res.destroy(); reject(fail([401,403,429].includes(res.statusCode)?'WEB_ACCESS_DENIED':'WEB_UNAVAILABLE')); return; }
      const type = res.headers['content-type'] || '';
      if (!/^text\/html(?:;|$)/i.test(type)) { res.destroy(); reject(fail('WEB_UNSUPPORTED_TYPE')); return; }
      if (Number(res.headers['content-length']) > MAX_BYTES) { res.destroy(); reject(fail('WEB_PAGE_TOO_LARGE')); return; }
      let bytes = 0, decoded = 0, parts = [];
      const encoding = (res.headers['content-encoding'] || 'identity').toLowerCase();
      const transform = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null;
      if (!transform && encoding !== 'identity') { res.destroy(); reject(fail('WEB_UNSUPPORTED_ENCODING')); return; }
      const stream = transform || res;
      const stop = error => { res.destroy(); transform?.destroy(); reject(error); };
      res.on('error',stop); res.on('aborted',()=>stop(fail('WEB_UNAVAILABLE')));
      res.on('data', chunk => { bytes += chunk.length; if(bytes>MAX_BYTES) stop(fail('WEB_PAGE_TOO_LARGE')); });
      stream.on('error',stop);
      stream.on('data', chunk => { decoded += chunk.length; if(decoded>MAX_BYTES) stop(fail('WEB_PAGE_TOO_LARGE')); else parts.push(chunk); });
      stream.on('end',()=>resolve({buffer:Buffer.concat(parts),type}));
      if(transform) res.pipe(transform);
    });
    req.on('error',reject); req.end();
  });
}
async function read(value, parentSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason || fail('WEB_UNAVAILABLE'));
  if(parentSignal?.aborted) abort(); else parentSignal?.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(()=>controller.abort(fail('WEB_TIMEOUT')),TIMEOUT_MS);
  try {
    let url = normalize(value);
    for(let hop=0;hop<=3;hop++) {
      const parsed = new URL(url), record = await addressFor(parsed,controller.signal);
      const response = await request(parsed,record,controller.signal);
      if ('location' in response) {
        if(!response.location || hop===3) throw fail('WEB_REDIRECT_LIMIT');
        url = normalize(new URL(response.location,url).href); continue;
      }
      return { url, ...html.extract(response.buffer,response.type), fetchedAt:new Date().toISOString() };
    }
  } catch(error) {
    if(parentSignal?.aborted) throw parentSignal.reason || error;
    if(controller.signal.aborted) throw fail('WEB_TIMEOUT');
    throw error.webError ? error : fail('WEB_UNAVAILABLE');
  } finally {clearTimeout(timer);parentSignal?.removeEventListener('abort',abort);}
}
module.exports = { read, addressFor, request, MAX_BYTES, TIMEOUT_MS };
