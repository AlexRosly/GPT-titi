const test = require('node:test');
const assert = require('node:assert/strict');
const { ResponsesSession, configuration } = require('../../src/services/chatDeliveryV2/responsesProvider');
const { additions } = require('../../src/config/modelCatalog202611');
const done = (id, output = [], status = 'completed') => ({ id, status, output, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } });
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
const call = (id, name = 'sample') => ({ type: 'function_call', id: 'fc_' + id, call_id: id, name, arguments: '{"ok":true}', status: 'completed' });
const input = [{ role: 'system', content: 'System policy' }, { role: 'user', content: 'Привіт' }];
const tool = { type: 'function', function: { name: 'sample', strict: true, parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } };

for (const model of additions) test(`${model.modelId}: exact ID, explicit effort, image conversion and answer streaming`, async () => {
  const requests = [], ids = [], deltas = [];
  const client = { responses: { async *create(request) {
    requests.push(request);
    yield { type: 'response.created', response: { id: 'resp_1' } };
    yield { type: 'response.reasoning_summary_text.delta', delta: 'private reasoning' };
    yield { type: 'response.output_text.delta', delta: 'Вітаю' };
    yield { type: 'response.completed', response: done('resp_1', [message('Вітаю')]) };
  } } };
  const session = new ResponsesSession(client, model, { onResponseId: async id => ids.push(id) });
  const result = await session.request({ model: model.modelId, messages: [...input, { role: 'assistant', content: 'Попередня відповідь' },
    { role: 'user', content: [{ type: 'text', text: 'OCR text' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=', detail: 'low' } }] }],
    tools: [tool], tool_choice: { type: 'function', function: { name: 'sample' } }, max_completion_tokens: 2048 }, {}, async delta => deltas.push(delta));
  const request = requests[0];
  assert.equal(request.model, model.modelId);
  assert.deepEqual(request.reasoning, { effort: model.reasoningEffort });
  assert.equal(request.instructions, 'System policy');
  assert.equal(request.store, false);
  assert.equal(request.messages, undefined);
  assert.equal(request.stream_options, undefined);
  assert.equal(request.previous_response_id, undefined);
  assert.equal(request.max_output_tokens, 2048);
  assert.equal(request.input[1].role, 'assistant');
  assert.equal(request.input[2].content[1].type, 'input_image');
  assert.equal(request.tools[0].name, 'sample');
  assert.equal(request.tools[0].function, undefined);
  assert.deepEqual(request.tool_choice, { type: 'function', name: 'sample' });
  assert.deepEqual(deltas, ['Вітаю']);
  assert.deepEqual(ids, ['resp_1']);
  assert.equal(result.text, 'Вітаю');
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
});

test('multiple function calls preserve original reasoning/output order and call_id on continuation', async () => {
  const requests = [];
  const output = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' }, call('a'), call('b')];
  const client = { responses: { async *create(request) {
    requests.push(request);
    yield { type: 'response.completed', response: requests.length === 1 ? done('resp_1', output) : done('resp_2', [message('Done')]) };
  } } };
  const session = new ResponsesSession(client, additions[2]);
  const result = await session.request({ model: additions[2].modelId, messages: input, tools: [tool] });
  assert.equal(result.calls.length, 2);
  await session.request({ model: additions[2].modelId, messages: [...input,
    { role: 'assistant', content: null, tool_calls: result.calls.map(c => ({ id: c.call_id })) },
    { role: 'tool', tool_call_id: 'a', content: '{"ok":true}' }, { role: 'tool', tool_call_id: 'b', content: '{"ok":false}' }] });
  assert.deepEqual(requests[1].input.slice(1, 4), output);
  assert.equal(requests[1].input[4].call_id, 'a');
  assert.equal(requests[1].input[5].call_id, 'b');
  assert.equal(requests[1].instructions, requests[0].instructions);
});

test('browser facade carries actual tool output and encrypted reasoning into fresh observation requests', async () => {
  const requests = [];
  const output = [{ type: 'reasoning', id: 'rs', encrypted_content: 'encrypted' }, call('browse_1', 'browse')];
  const session = new ResponsesSession({ responses: { async *create(req) {
    requests.push(req);
    yield { type: 'response.completed', response: requests.length === 1 ? done('r1', output) : done('r2', [message('Answer')]) };
  } } }, additions[3]);
  const facade = session.asChatClient();
  const response = await facade.chat.completions.create({ model: additions[3].modelId, messages: input });
  assert.equal(response.choices[0].message.tool_calls[0].id, 'browse_1');
  session.rememberToolResult('browse_1', { text: 'Observed evidence' });
  await facade.chat.completions.create({ model: additions[3].modelId, messages: [...input, { role: 'user', content: 'Next observation' }] });
  const request = requests[1];
  assert.deepEqual(request.input.slice(1, 3), output);
  assert.match(request.input[3].output, /Observed evidence/);
  assert.equal(request.input[4].content[0].text, 'Next observation');
});

for (const status of ['failed', 'incomplete', 'cancelled']) test(`terminal ${status} never reports successful completion`, async () => {
  const session = new ResponsesSession({ responses: { async *create() {
    yield { type: 'response.' + status, response: done('resp_failed', [], status) };
  } } }, additions[0]);
  await assert.rejects(session.request({ model: additions[0].modelId, messages: input }), e => !!e.protocolError && e.providerResponse.status === status);
});

test('stream EOF and partial function arguments never become a completed function call', async () => {
  const session = new ResponsesSession({ responses: { async *create() {
    yield { type: 'response.function_call_arguments.delta', item_id: 'a', delta: '{"code":' };
  } } }, additions[0]);
  await assert.rejects(session.request({ model: additions[0].modelId, messages: input }), e => e.protocolError.code === 'PROVIDER_STREAM_INTERRUPTED');
});

test('a terminal response containing an unfinished function never executes that function', async () => {
  const session = new ResponsesSession({ responses: { async *create() {
    yield { type: 'response.completed', response: done('resp_bad', [{ ...call('a'), status: 'in_progress' }]) };
  } } }, additions[0]);
  await assert.rejects(session.request({ model: additions[0].modelId, messages: input }), e => e.protocolError.code === 'PROVIDER_INVALID_RESPONSE');
});

test('abort signal prevents or interrupts provider execution', async () => {
  const controller = new AbortController();
  let calls = 0;
  const session = new ResponsesSession({ responses: { async *create() {
    calls++;
    yield { type: 'response.created', response: { id: 'r' } };
    controller.abort();
    yield { type: 'response.output_text.delta', delta: 'late' };
  } } }, additions[0]);
  await assert.rejects(session.request({ model: additions[0].modelId, messages: input }, { signal: controller.signal }), e => e.name === 'AbortError');
  await assert.rejects(session.request({ model: additions[0].modelId, messages: input }, { signal: controller.signal }), e => e.name === 'AbortError');
  assert.equal(calls, 1);
});

test('missing effort and unsupported built-in tools fail before making a provider request', () => {
  assert.throws(() => configuration({ apiMode: 'responses' }));
  for (const model of additions.slice(2)) assert.throws(() => configuration({ ...model, reasoningEffort: 'none' }));
  assert.deepEqual(configuration({}), { apiMode: 'chat_completions' });
  const session = new ResponsesSession({}, additions[0]);
  assert.throws(() => session.prepare({ model: additions[0].modelId, messages: input, tools: [{ type: 'web_search' }] }));
});

module.exports = { done, message, call };
