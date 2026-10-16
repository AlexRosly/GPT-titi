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
test('SVG tool contract accepts static drawings with gradients and text', () => {
  const options = a.toolOptions({ filename: 'cat.SVG' });
  const description = options.tools[0].function.description;
  assert.match(description, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(description, /never use style or class/);
  assert.match(description, /XML declarations/);
  assert.match(description, /url\(#id\)/);
  assert.equal(options.tool_choice.function.name, 'create_file');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="fur"><stop offset="0" stop-color="orange"/><stop offset="1" stop-color="gold"/></linearGradient></defs><circle cx="50" cy="50" r="30" fill="url(#fur)"/><path d="M25 30 L20 5 L45 20" fill="orange"/><text x="50" y="95" text-anchor="middle">Cat &amp; friend</text></svg>';
  const rendered = a.render({ filename: 'cat.SVG' }, svg);
  assert.equal(rendered.mimetype, 'image/svg+xml');
  assert.match(rendered.buffer.toString(), /linearGradient/);
  assert.match(rendered.buffer.toString(), /Cat &amp; friend/);
  // Every advertised element/attribute is accepted; existing security checks remain active.
  const elements = description.match(/elements: ([^.]+)\./)[1].split(', ');
  const attrs = description.match(/attributes: ([^.]+)\./)[1].split(', ');
  for (const element of elements) assert.doesNotThrow(() => a.sanitizeSvg(`<svg><${element}/></svg>`));
  for (const attr of attrs) assert.doesNotThrow(() => a.sanitizeSvg(`<svg ${attr}="${attr === 'xmlns' ? 'http://www.w3.org/2000/svg' : '1'}"/>`));
  assert.throws(() => a.render({ filename: 'cat.svg' }, '<?xml version="1.0"?><svg/>'));
});
test('SVG-specific instructions do not leak into other file formats', () => {
  for (const filename of ['notes.txt', 'notes.md', 'data.csv', 'data.json', 'app.js']) {
    const description = a.toolOptions({ filename }).tools[0].function.description;
    assert.ok(description.includes(filename));
    assert.doesNotMatch(description, /SVG|xmlns|case-sensitive elements/);
  }
});

test('automatic tool selection permits plain text and validates model filenames', () => {
  assert.equal(a.autoToolOptions().tool_choice, 'auto');
  assert.ok(a.autoToolOptions().tools[0].function.parameters.required.includes('filename'));
  const plain = a.collector({ optional: true });
  plain.add({ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] });
  assert.deepEqual(plain.finish(), {});
  for (const [filename, error] of [['cat.svg', null], ['../cat.svg', 'INVALID_FILENAME'], ['cat.pdf', 'UNSUPPORTED_OUTPUT_FORMAT']]) {
    const c = a.collector({ optional: true });
    const args = JSON.stringify({ filename, content: '<svg/>', summary: 'Cat' });
    c.add({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'create_file', arguments: args.slice(0, 17) } }] } }] });
    c.add({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(17) } }] }, finish_reason: 'tool_calls' }] });
    const result = c.finish();
    if (error) assert.equal(result.artifactError, error);
    else assert.equal(result.artifact.filename, filename);
  }
});
test('automatic collector rejects incomplete and multiple tool calls', () => {
  for (const [index, finish_reason] of [[0, 'length'], [1, 'tool_calls']]) {
    const c = a.collector({ optional: true });
    c.add({ choices: [{ delta: { tool_calls: [{ index, function: { name: 'create_file', arguments: '{}' } }] }, finish_reason }] });
    assert.equal(c.finish().artifactError, 'INCOMPLETE_FILE_OUTPUT');
  }
});
test('automatic files honor private storage, model allowlist and opt-out', () => {
  const keys = ['PRIVATE_FILES_ENABLED', 'FILE_OUTPUT_MODELS', 'FILE_OUTPUT_AUTO_ENABLED'];
  const previous = keys.map(k => process.env[k]);
  try {
    process.env.PRIVATE_FILES_ENABLED = 'true'; process.env.FILE_OUTPUT_MODELS = ' model-a, model-b ';
    delete process.env.FILE_OUTPUT_AUTO_ENABLED;
    assert.equal(a.autoEnabled('model-a'), true);
    assert.equal(a.autoEnabled('other'), false);
    process.env.FILE_OUTPUT_AUTO_ENABLED = 'false'; assert.equal(a.autoEnabled('model-a'), false);
    delete process.env.FILE_OUTPUT_AUTO_ENABLED;
    process.env.PRIVATE_FILES_ENABLED = 'false'; assert.equal(a.autoEnabled('model-a'), false);
  } finally { keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; }); }
});
test('SVG repairs only the known none paint typo without relaxing security', () => {
  const svg = a.sanitizeSvg('<svg><path fill="#none" stroke=" #NONE " d="M0 0 L1 1"/><g id="#none"/></svg>');
  assert.match(svg, /fill="none" stroke="none"/);
  assert.match(svg, /id="#none"/);
  assert.throws(() => a.sanitizeSvg('<svg><path fill="#none" onload="alert(1)"/></svg>'));
  assert.throws(() => a.sanitizeSvg('<svg><path fill="url(https:\/\/evil)"/></svg>'));
});
