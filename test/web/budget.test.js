const test = require('node:test'), assert = require('node:assert/strict');
const { estimate } = require('../../src/services/web/budget');
const pricing = { inputPerM: 2.5, outputPerM: 10, tokenValueUsd: 0.00001 };
test('actual short web context and one bounded output fit a new 10000-token account', () => {
  const b = estimate([{ role:'user', content:'Summarize https://example.com' }, { role:'user', content:'Article text. '.repeat(200) }], [], pricing);
  assert.equal(b.outputTokens,4096); assert.ok(b.amount < 10000);
  assert.equal(b.amount,Math.ceil((b.promptTokens * 2.5 + b.outputTokens * 10) / 10));
});
test('history, tools, multilingual text and images all contribute to the actual reserve', () => {
  const messages = [{role:'user',content:'Hello'}];
  const base = estimate(messages,[],pricing);
  const text = estimate([...messages,{role:'assistant',content:'Україна 日本語 العربية '.repeat(100)}],[],pricing);
  assert.ok(text.amount > base.amount);
  assert.ok(estimate(messages,[{type:'function',function:{name:'create_file',description:'Document schema '.repeat(100)}}],pricing).amount > base.amount);
  assert.ok(estimate([{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AA'}}]}],[],pricing).promptTokens >= 32768);
  assert.throws(()=>estimate([{role:'user',content:'a'.repeat(300000)}],[],pricing),{webError:'WEB_CONTEXT_TOO_LARGE'});
  assert.throws(()=>estimate(messages,[],{...pricing,inputPerM:NaN}),{webError:'WEB_CONFIGURATION_ERROR'});
  assert.doesNotThrow(()=>estimate([{role:'user',content:'<|endoftext|> literal text'}],[],pricing));
});
