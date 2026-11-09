const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../../src/services/chatDeliveryV2/responsesTurn');
const artifacts = require('../../src/services/files/artifacts');
const exact = require('../../src/services/files/exactTranscription');
const compute = require('../../src/services/computation/policy');
const accounting = require('../../src/services/computation/accounting');
const leases = require('../../src/services/computation/leases');
const execute = require('../../src/services/computation/execute');
const { additions } = require('../../src/config/modelCatalog202611');

const fn = (id, name, args) => ({ id: 'fc_' + id, type: 'function_call', call_id: id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args), status: 'completed' });
const text = value => ({ type: 'message', content: [{ type: 'output_text', text: value }] });
function setup(t, outputs) {
  const previous = process.env.PRIVATE_FILES_ENABLED;
  process.env.PRIVATE_FILES_ENABLED = 'true';
  t.after(() => { if (previous === undefined) delete process.env.PRIVATE_FILES_ENABLED; else process.env.PRIVATE_FILES_ENABLED = previous; });
  const requests = [], checkpoints = [], deltas = [], ids = [];
  const turn = { _id: 'test-turn', turnId: 'uuid', attempt: 1, user: 'user', modelId: additions[0].modelId };
  const client = { responses: { async *create(request) {
    requests.push(request);
    const output = outputs[requests.length - 1];
    if (!output) throw Error('Unexpected extra provider call');
    yield { type: 'response.created', response: { id: 'resp_' + requests.length } };
    for (const item of output) if (item.type === 'message') yield { type: 'response.output_text.delta', delta: item.content[0].text };
    yield { type: 'response.completed', response: { id: 'resp_' + requests.length, status: 'completed', output,
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } };
  } } };
  return { turn, client, requests, checkpoints, deltas, ids,
    args: { turn, token: 'lease', model: additions[0], client,
      messages: [{ role: 'system', content: 'App policy' }, { role: 'user', content: 'Зроби завдання' }],
      fileTools: {}, computeFiles: [], exactFiles: [], signal: new AbortController().signal, providerProgress: {},
      onText: async delta => deltas.push(delta), onResponseId: async id => ids.push(id),
      save: async value => { checkpoints.push(structuredClone(value)); Object.assign(turn, value); } } };
}

test('plain answer streams with actual usage and one request', async t => {
  const f = setup(t, [[text('Українська відповідь')]]);
  const result = await run(f.args);
  assert.deepEqual(f.deltas, ['Українська відповідь']);
  assert.equal(result.assistantText, 'Українська відповідь');
  assert.equal(result.usage.totalTokens, 13);
  assert.equal(f.turn.responseState.pending, false);
  assert.deepEqual(f.ids, ['resp_1']);
});

for (const [filename, content] of [
  ['report.docx', { title: 'Звіт', blocks: [{ type: 'paragraph', text: 'Документ українською.' }] }],
  ['table.xlsx', { sheets: [{ name: 'Дані', rows: [['Товар', 'Кількість'], ['Яблука', 3]] }] }],
]) test(`${filename}: validates an actual Office manifest and continues to final response`, async t => {
  const f = setup(t, [[fn('file_1', 'create_file', { filename, content: JSON.stringify(content), summary: 'Готовий файл' })], [text('Завершено')]]);
  f.args.fileTools = artifacts.autoToolOptions(f.args.model);
  const result = await run(f.args);
  assert.equal(f.requests.length, 2);
  assert.equal(result.artifact.filename, filename);
  assert.equal(result.usage.totalTokens, 26);
  assert.ok(f.requests[1].input.some(item => item.type === 'function_call_output' && item.call_id === 'file_1'));
  assert.equal(f.requests[1].tools, undefined);
});

test('multiple calls return one output per call, and a forbidden tool is never executed', async t => {
  const f = setup(t, [[{ type: 'reasoning', id: 'rs', encrypted_content: 'opaque' },
    fn('a', 'create_file', { filename: 'a.txt', content: 'hello', summary: 'Ready' }), fn('b', 'delete_everything', {})], [text('Finished')]]);
  f.args.fileTools = artifacts.autoToolOptions(f.args.model);
  const result = await run(f.args);
  assert.equal(result.artifact.content, 'hello');
  const outputs = f.requests[1].input.filter(i => i.type === 'function_call_output');
  assert.deepEqual(outputs.map(o => o.call_id), ['a', 'b']);
  assert.equal(JSON.parse(outputs[1].output).error, 'TOOL_NOT_AVAILABLE');
  assert.equal(f.requests[1].input.filter(i => i.type === 'reasoning').length, 1);
});

test('malformed complete tool JSON returns a tool error without rendering or inventing a file', async t => {
  const f = setup(t, [[fn('a', 'create_file', '{broken')], [text('Invalid arguments')]]);
  f.args.fileTools = artifacts.autoToolOptions(f.args.model);
  const render = t.mock.method(artifacts, 'renderOutput', async () => { throw Error('Must not render invalid arguments'); });
  const result = await run(f.args);
  assert.equal(render.mock.callCount(), 0);
  assert.equal(result.artifact, undefined);
  assert.equal(result.artifactError, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(result.usage.totalTokens, 26);
});

test('partial stream does not execute tools, complete a turn, or fabricate usage', async t => {
  const f = setup(t, []);
  f.args.fileTools = artifacts.autoToolOptions(f.args.model);
  f.args.client.responses.create = async function* () {
    yield { type: 'response.function_call_arguments.delta', item_id: 'a', delta: '{"filename":"a.txt"' };
  };
  const render = t.mock.method(artifacts, 'renderOutput', async () => {});
  await assert.rejects(run(f.args), error => error.protocolError.code === 'PROVIDER_STREAM_INTERRUPTED');
  assert.equal(render.mock.callCount(), 0);
  assert.equal(f.turn.responseState.pending, true);
  assert.equal(f.turn.responseState.usage.totalTokens, 0);
});

test('multiple sequential computations share the lease, checkpoints and real cumulative usage', async t => {
  const python = { code: 'print(1)', fileIds: [], exports: [] };
  const f = setup(t, [[fn('a', 'run_python', python), fn('b', 'run_python', python)], [fn('c', 'run_python', python)], [text('Result: 1')]]);
  f.args.fileTools = { tools: [compute.tool], tool_choice: 'auto' };
  let acquired = 0, released = 0, executed = 0;
  t.mock.method(leases, 'acquire', async () => { acquired++; return async () => { released++; }; });
  t.mock.method(accounting, 'begin', async () => { f.turn.computeState.pending = true; });
  t.mock.method(accounting, 'received', async (_, __, usage) => {
    const state = f.turn.computeState;
    state.pending = false;
    state.usage = { promptTokens: state.usage.promptTokens + usage.prompt_tokens,
      completionTokens: state.usage.completionTokens + usage.completion_tokens, totalTokens: state.usage.totalTokens + usage.total_tokens };
  });
  t.mock.method(execute, 'run', async args => {
    executed++;
    await args.save({ ...f.turn.computeState, runs: executed });
    return { result: { ok: true, text: '1', truncated: false }, next: f.turn.computeState };
  });
  const result = await run(f.args);
  assert.equal(executed, 3);
  assert.equal(acquired, 1);
  assert.equal(released, 1);
  assert.equal(result.usage.totalTokens, 39);
  assert.equal(result.computation.runs, 3);
  assert.deepEqual(f.requests[2].input.filter(i => i.type === 'function_call_output').map(i => i.call_id), ['a', 'b', 'c']);
});

test('exact OCR output remains verbatim after provider continuation', async t => {
  const id = '0123456789abcdef01234567';
  const f = setup(t, [[fn('ocr', exact.NAME, { fileIds: [id] })], [text('Rewritten text that must not replace extraction')]]);
  f.args.exactFiles = [{ id, name: 'scan.pdf' }];
  f.args.fileTools = { tools: [exact.options(f.args.exactFiles).tool] };
  t.mock.method(exact, 'render', async (user, selection) => {
    assert.equal(user, f.turn.user); assert.deepEqual(selection.ids, [id]);
    return 'VERBATIM SAVED EXTRACTION';
  });
  const result = await run(f.args);
  assert.equal(result.assistantText, 'VERBATIM SAVED EXTRACTION');
  assert.deepEqual(f.deltas, []);
});

test('bounded tool loop never runs a seventh provider request', async t => {
  const f = setup(t, Array.from({ length: 6 }, (_, i) => [fn('call' + i, 'unknown', {})]));
  await assert.rejects(run(f.args), error => error.protocolError.code === 'PROVIDER_RESPONSE_INCOMPLETE');
  assert.equal(f.requests.length, 6);
  assert.equal(f.turn.responseState.usage.totalTokens, 78);
  assert.equal(f.turn.responseState.pending, false);
});
