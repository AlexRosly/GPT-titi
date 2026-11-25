const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../src/services/web/policy');
const source = require('../../src/services/web/sourceTool');
process.env.WEB_READING_V2_ENABLED = 'true';
const a = 'https://example.org/guide', b = 'https://example.com/prices';
test('only a plain list is an automatic read; the whole text of any prose goes to the selected model', () => {
  assert.deepEqual(policy.plan(a + '\n' + b, {}).urls, [a,b]);
  assert.equal(policy.plan('«Read ' + a + '»', {}), null);
  assert.equal(policy.plan('```\n' + a + '\n```', {}), null);
  assert.equal(policy.plan('هل يمكنك قراءة ' + a + '؟', {}), null);
  assert.equal(policy.plan('请阅读' + a + '。', {}), null);
  assert.deepEqual([...source.candidates('देखें ' + a + '।')], [a]);
  assert.deepEqual([...source.candidates('اقرأ ⁧' + b + '⁩، ثم وضّح.')], [b]);
  assert.deepEqual([...source.candidates('请阅读《https://例子.中国/指南》。')], [new URL('https://例子.中国/指南').href]);
  assert.deepEqual([...source.candidates('例：' + a + '、' + b + '。')], [a,b]);
  assert.deepEqual([...source.candidates('https://example.org/путівник?сторінка=два')], [new URL('https://example.org/путівник?сторінка=два').href]);
  assert.deepEqual([...source.candidates('Read [website](' + a + ') and www.example.com.')], [a, 'https://www.example.com/']);
  assert.deepEqual([...source.candidates('Use help@example.org')], []);
});
test('backend permits only current public candidates respecting limits and canonicalization', () => {
  const allowed = source.candidates(a + ' ' + b + ' http://192.168.0.1');
  assert.deepEqual(source.resolve(JSON.stringify({urls:[b, a+'#title']}), allowed), [b,a]);
  for (const args of [null,'{}','{"urls":[]}',JSON.stringify({urls:[a,a,b,b]}),
    JSON.stringify({urls:[a, 'https://example.org/other']}), JSON.stringify({urls:['http://192.168.0.1']}),
    JSON.stringify({urls:[b],other:true}), JSON.stringify({urls:[42]})]) {
    assert.equal(source.resolve(args, allowed), null);
  }
  assert.throws(() => policy.plan('192.168.0.1', {}), {webError:'WEB_BLOCKED_ADDRESS'});
});
test('streamed selection runs only after a complete solo function call', () => {
  const c = source.collector();
  c.add({choices:[{delta:{tool_calls:[{index:0,id:'c',function:{name:'read_supplied_',arguments:'{"urls":'}}]}}]});
  c.add({choices:[{delta:{tool_calls:[{index:0,function:{name:'pages',arguments:'[]}'}}]}}]});
  assert.equal(c.finish('length'), null);
  assert.equal(c.finish('tool_calls'), '{"urls":[]}');
  c.add({choices:[{delta:{tool_calls:[{index:1,function:{name:'other'}}]}}]});
  assert.equal(c.finish('tool_calls'), null);
});

for (const {locale, scenario, message, expected} of require('./sourceCases')) {
  test(locale + ' / ' + scenario + ' — extraction and enforcement with a fixed model decision', () => {
    assert.equal(policy.plan(message, {}), null);
    const allowed = source.candidates(message);
    for (const link of ['https://example.org/first', 'https://example.net/second']) {
      assert.equal(allowed.has(link), message.includes(link));
    }
    if (scenario === 'router') assert.equal(allowed.size, 0);
    if (expected.length) assert.deepEqual(source.resolve(JSON.stringify({urls:expected}), allowed), expected);
  });
}
