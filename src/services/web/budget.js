const { getEncoding } = require('js-tiktoken');
const { fail, OUTPUT_TOKENS } = require('./policy');
let encodings;
function estimate(messages, tools, pricing) {
  // Upper estimate for the supported OpenAI text tokenizers, plus chat/tool
  // framing headroom. This is a reservation estimate, never billed usage.
  encodings ||= [getEncoding('cl100k_base'), getEncoding('o200k_base')];
  let images = 0;
  const input = messages.map(m => ({ ...m, content: Array.isArray(m.content)
    ? m.content.map(p => {
      if (p.type === 'image_url') { images++; return { type: 'image_url' }; }
      return p;
    }) : m.content }));
  const serialized = JSON.stringify({ messages: input, tools });
  if (Buffer.byteLength(serialized) > 256 * 1024) throw fail('WEB_CONTEXT_TOO_LARGE');
  const tokens = Math.max(...encodings.map(e => e.encode(serialized, [], []).length));
  const promptTokens = Math.ceil(tokens * 1.15) + 512 + messages.length * 16 + images * 32768;
  if (promptTokens + OUTPUT_TOKENS > 65536) throw fail('WEB_CONTEXT_TOO_LARGE');
  if (![pricing.inputPerM, pricing.outputPerM, pricing.tokenValueUsd].every(Number.isFinite) ||
      pricing.inputPerM < 0 || pricing.outputPerM < 0 || pricing.tokenValueUsd <= 0) throw fail('WEB_CONFIGURATION_ERROR');
  const amount = Math.ceil((promptTokens * pricing.inputPerM + OUTPUT_TOKENS * pricing.outputPerM) / 1e6 / pricing.tokenValueUsd);
  if (!Number.isSafeInteger(amount)) throw fail('WEB_CONFIGURATION_ERROR');
  return { promptTokens, outputTokens: OUTPUT_TOKENS, amount };
}
module.exports = { estimate };
