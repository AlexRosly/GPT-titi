// Decide which supplied links are sources before applying the network policy.
// Private-use markers exist only in this working copy; ChatTurn keeps the original.
const marker = '\uE000';
// Common schemeless addresses are accepted at token boundaries. Other public
// suffixes and internationalized hosts are supported with an explicit scheme.
const bareHost = String.raw`(?<![\p{L}\p{M}\p{N}_@/.-])(?:www\.(?:[\p{L}\p{M}\p{N}-]+\.)+[\p{L}\p{M}]{2,63}|(?:[\p{L}\p{N}][\p{L}\p{M}\p{N}-]{0,62}\.)+(?:com|org|net|edu|gov|info|biz|dev|app|online|site|tech|[a-z]{2}|xn--[a-z0-9-]{2,59})|(?:\d{1,3}\.){3}\d{1,3}|localhost)(?![\p{L}\p{M}\p{N}_@-]|\.[\p{L}\p{N}_-])`;
const tail = String.raw`[^\s<>"«»“”‘’\x60。，、！？；：「」『』【】（）《》؛،؟।॥។៕၊။።፣፤\u2066-\u2069\u200e\u200f]*`;
const link = new RegExp(String.raw`https?:\/\/` + tail + '|' + bareHost + '(?:[/:?#]' + tail + ')?', 'giu');

function trimLink(text) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const balance = {};
  for (const char of text) balance[char] = (balance[char] || 0) + 1;
  let end = text.length;
  while (end > 0) {
    const char = text[end - 1];
    if (!/[.,;!?']/u.test(char) && !(pairs[char] && balance[char] > (balance[pairs[char]] || 0))) break;
    balance[char]--;
    end--;
  }
  return text.slice(0, end);
}

function markLinks(message) {
  const urls = [];
  const text = String(message).replaceAll(marker, ' ').replace(link, (match, at, input) => {
    const closingQuote = input[at - 1] === "'" ? match.indexOf("'") : -1;
    const url = trimLink(closingQuote < 0 ? match : match.slice(0, closingQuote));
    const absolute = /^https?:/iu.test(url) ? url : 'https://' + url;
    const index = urls.push(absolute) - 1;
    return marker + index + marker + match.slice(url.length);
  });
  return { urls, text };
}

// A bare link or a list is the same shorthand in all languages. Any other
// words move the decision to the selected model's ordinary tool-choice turn.
function directUrls(message) {
  const { urls, text } = markLinks(message);
  if (!urls.length) return [];
  const remainder = text.replace(/\uE000\d+\uE000/gu, '').trim();
  if (!/^[\s<>(),.;!?•*\-\u200e\u200f\u2066-\u2069，、。؛،។៕၊။።፣፤]*$/u.test(remainder)) return [];
  return [...new Set(urls)];
}

const urlsIn = message => [...new Set(markLinks(message).urls)];
module.exports = { directUrls, urlsIn };
