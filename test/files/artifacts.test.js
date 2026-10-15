const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../../src/services/files/artifacts');
const { buildRequestHash } = require('../../src/services/chatDeliveryV2/protocol');
test('SVG reconstructs static markup and rejects active or external content', () => {
  const safe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/><text>A &amp; B</text></svg>';
  assert.match(a.sanitizeSvg(safe), /A &amp; B/);
  for (const evil of [
    '<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"/>',
    '<svg><foreignObject/></svg>', '<svg><image href="https://evil"/></svg>',
    '<svg><path fill="url(https://evil)"/></svg>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
    '<svg><style>@import url(https://evil)</style></svg>', '<svg><animate/></svg>', '<svg/><svg/>',
    '<svg><path fill="u\\72l(https://evil)"/></svg>', '<svg><path style="fill:red"/></svg>',
  ]) assert.throws(() => a.sanitizeSvg(evil), undefined, evil);
});
test('output formats are validated and code is stored without execution', () => {
  assert.throws(() => a.render({ filename: 'x.json' }, '{bad}'), { fileError: 'INVALID_JSON' });
  assert.equal(a.render({ filename: 'x.py' }, 'print("hello")').buffer.toString(), 'print("hello")');
  assert.throws(() => a.outputSpec({ filename: '../x.py' }));
  assert.throws(() => a.outputSpec({ filename: 'x.exe' }));
});
test('CSV preserves quoted multiline cells and neutralizes formulas', () => {
  const csv = a.render({ filename: 'x.csv' }, 'name,value\n"a,b","=HYPERLINK(""evil"")"\n"two\nlines",-42').buffer.toString();
  assert.match(csv, /"a,b"/); assert.match(csv, /'=HYPERLINK/); assert.match(csv, /"-42"/); assert.match(csv, /two\nlines/);
  assert.throws(() => a.render({ filename: 'x.csv' }, '"unclosed'));
});
test('tool collector joins arguments across chunks and refuses truncated results', () => {
  const c = a.collector();
  c.add({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'create_file', arguments: '{"content":"he' } }] } }] });
  c.add({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'llo","summary":"Done"}' } }] }, finish_reason: 'tool_calls' }] });
  assert.equal(c.finish().artifact.content, 'hello');
  const bad = a.collector(); bad.add({ choices: [{ delta: {}, finish_reason: 'length' }] });
  assert.equal(bad.finish().artifactError, 'INCOMPLETE_FILE_OUTPUT');
});
test('output filename participates in request idempotency', () => {
  const p = { userId: 'u', conversationId: 'c', modelId: 'm', message: 'hi' };
  assert.notEqual(buildRequestHash(p), buildRequestHash({ ...p, outputFile: { filename: 'a.txt' } }));
});
