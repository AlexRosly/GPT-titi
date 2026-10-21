const { parseDocument } = require('htmlparser2');
const iconv = require('iconv-lite');
const { fail, PAGE_BYTES } = require('./policy');
const ignored = new Set(['script','style','noscript','template','svg','canvas','iframe','object','embed','form','nav','footer','header','aside']);
const blocks = new Set(['p','div','section','article','main','br','li','ul','ol','table','tr','h1','h2','h3','h4','h5','h6','blockquote','pre']);
const clean = s => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').replace(/[\t ]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
function clip(text, limit) {
  let bytes = 0, result = '';
  for (const char of text) { const size = Buffer.byteLength(char); if (bytes + size > limit) break; result += char; bytes += size; }
  return result;
}
function extract(buffer, contentType) {
  const declared = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ||
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(buffer.subarray(0,4096).toString('ascii'))?.[1] || 'utf-8';
  if (!iconv.encodingExists(declared)) throw fail('WEB_UNSUPPORTED_ENCODING');
  const html = iconv.decode(buffer, declared);
  const doc = parseDocument(html, { decodeEntities:true });
  let title = '', candidates = [], scriptCount = 0, nodes = 0;
  function text(node, depth = 0) {
    if (++nodes > 100000 || depth > 128) throw fail('WEB_PAGE_TOO_LARGE');
    if (node.type === 'text') return node.data || '';
    const name = node.name || '', attrs = node.attribs || {};
    if (name === 'script') scriptCount++;
    if (ignored.has(name) || 'hidden' in attrs || attrs['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style || '')) return '';
    const value = (node.children || []).map(n => text(n, depth + 1)).join('');
    if (name === 'title') { title = clean(value).slice(0,300); return ''; }
    if (name === 'main' || name === 'article' || attrs.role === 'main') candidates.push(value);
    return blocks.has(name) ? '\n' + value + '\n' : ['td','th'].includes(name) ? value + ' | ' : value;
  }
  const body = clean(text(doc));
  const preferred = candidates.map(clean).sort((a,b)=>b.length-a.length)[0];
  const result = preferred?.length >= 80 ? preferred : body;
  if (result.length < 1000 && /verify (?:you are|that you are) human|checking your browser|captcha|access denied/i.test(title + ' ' + result)) throw fail('WEB_ACCESS_DENIED');
  if (result.length < 80 && (scriptCount || /enable javascript/i.test(result))) throw fail('WEB_JAVASCRIPT_REQUIRED');
  if (!result) throw fail('WEB_NO_READABLE_TEXT');
  return { title, text:clip(result,PAGE_BYTES), truncated:Buffer.byteLength(result)>PAGE_BYTES };
}
module.exports = { extract, clip };
