// Provider boundary only. App tools, reservations, history selection and V2 stay local.
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const failure = (code, message) => Object.assign(new Error(message || code), {
  protocolError: { code, message: message || code, retryable: false },
});

function configuration(model = {}) {
  const apiMode = model.apiMode || 'chat_completions';
  if (!['chat_completions', 'responses'].includes(apiMode)) throw failure('MODEL_NOT_AVAILABLE', 'Unsupported model API mode.');
  if (apiMode === 'responses' && !EFFORTS.includes(model.reasoningEffort)) {
    throw failure('MODEL_NOT_AVAILABLE', 'Responses model reasoning effort must be configured.');
  }
  const supported = require('../../config/modelCatalog202611').allowedEfforts[model.modelId];
  if (apiMode === 'responses' && supported && !supported.includes(model.reasoningEffort)) {
    throw failure('MODEL_NOT_AVAILABLE', 'Reasoning effort is not supported by this model.');
  }
  return { apiMode, ...(apiMode === 'responses' ? { reasoningEffort: model.reasoningEffort } : {}) };
}

function content(value) {
  if (typeof value === 'string') return [{ type: 'input_text', text: value }];
  if (!Array.isArray(value)) throw failure('INTERNAL_ERROR', 'Unsupported prepared message content.');
  return value.map(part => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail || 'auto' };
    throw failure('INTERNAL_ERROR', 'Unsupported prepared attachment type.');
  });
}

function toolsForResponses(tools = []) {
  return tools.map(tool => {
    if (tool.type !== 'function' || !tool.function?.name) throw failure('INTERNAL_ERROR', 'Only application functions may be passed to Responses.');
    return { type: 'function', ...tool.function };
  });
}

class ResponsesSession {
  constructor(client, model, { onResponseId = async () => {} } = {}) {
    this.client = client;
    this.model = model;
    this.config = configuration(model);
    this.onResponseId = onResponseId;
    this.outputs = new Map();
    this.continuation = [];
    this.recorded = new Set();
    this.last = null;
  }

  prepare(request) {
    const input = [], instructions = [], seen = new Set();
    let explicitContinuation = false;
    for (const message of request.messages) {
      if (['system', 'developer'].includes(message.role)) {
        if (typeof message.content !== 'string') throw failure('INTERNAL_ERROR', 'Invalid system instructions.');
        instructions.push(message.content);
      } else if (message.role === 'tool') {
        explicitContinuation = true;
        input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
      } else if (message.tool_calls?.length) {
        explicitContinuation = true;
        for (const call of message.tool_calls) {
          const response = this.outputs.get(call.id);
          if (!response) throw failure('INTERNAL_ERROR', 'Missing Responses continuation items.');
          if (!seen.has(response.id)) { input.push(...response.output); seen.add(response.id); }
        }
      } else if (message.role === 'assistant') {
        if (message.content) input.push({ role: 'assistant', content: message.content });
      } else if (message.role === 'user') {
        input.push({ role: 'user', content: content(message.content) });
      } else throw failure('INTERNAL_ERROR', 'Unsupported prepared message role.');
    }
    if (!explicitContinuation && this.continuation.length) input.splice(Math.max(0, input.length - 1), 0, ...this.continuation);
    const options = {
      model: request.model,
      instructions: instructions.join('\n\n'), input,
      reasoning: { effort: this.config.reasoningEffort },
      stream: true, store: false, include: ['reasoning.encrypted_content'],
    };
    if (request.tools?.length) {
      options.tools = toolsForResponses(request.tools);
      options.parallel_tool_calls = false;
      options.tool_choice = request.tool_choice?.type === 'function'
        ? { type: 'function', name: request.tool_choice.function.name }
        : request.tool_choice || 'auto';
    }
    if (request.max_completion_tokens !== undefined) options.max_output_tokens = request.max_completion_tokens;
    return options;
  }

  async *events(request, options = {}) {
    options.signal?.throwIfAborted();
    let terminal = null, text = '', started = false;
    const argumentSizes = new Map();
    const ids = new Set();
    const rememberId = async response => {
      if (typeof response?.id === 'string' && !ids.has(response.id)) {
        ids.add(response.id);
        await this.onResponseId(response.id);
      }
    };
    try {
      const stream = await this.client.responses.create(this.prepare(request), options);
      try {
        for await (const event of stream) {
          started = true;
          options.signal?.throwIfAborted();
          if (event.response) await rememberId(event.response);
          if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
            const delta = event.delta || '';
            text += delta;
            yield { kind: 'text', text: delta };
          }
          if (event.type === 'response.function_call_arguments.delta') {
            const size = (argumentSizes.get(event.item_id) || 0) + Buffer.byteLength(event.delta || '');
            if (size > 2 * 1024 ** 2 || argumentSizes.size > 16) throw failure('PROVIDER_INVALID_RESPONSE', 'Tool argument limit exceeded.');
            argumentSizes.set(event.item_id, size);
          }
          if (['response.completed', 'response.incomplete', 'response.failed', 'response.cancelled'].includes(event.type)) {
            terminal = event.response;
            break;
          }
          if (event.type === 'error') throw failure('PROVIDER_UNAVAILABLE', 'OpenAI reported a streaming error.');
        }
      } finally { stream.controller?.abort(); }
      if (!terminal) throw failure('PROVIDER_STREAM_INTERRUPTED', 'Provider stream ended without a terminal response.');
      if (terminal.status !== 'completed') {
        throw Object.assign(failure(terminal.status === 'incomplete' ? 'PROVIDER_RESPONSE_INCOMPLETE' : 'PROVIDER_UNAVAILABLE',
          `Provider response ${terminal.status || 'failed'}.`), { providerResponse: terminal });
      }
      if (!Array.isArray(terminal.output)) throw failure('PROVIDER_INVALID_RESPONSE', 'Missing provider output items.');
      const calls = terminal.output.filter(item => item.type === 'function_call');
      if (calls.length > 16 || new Set(calls.map(call => call.call_id)).size !== calls.length) throw failure('PROVIDER_INVALID_RESPONSE', 'Invalid tool calls.');
      for (const call of calls) {
        if (call.status !== 'completed' || typeof call.call_id !== 'string' || !call.call_id || typeof call.name !== 'string' ||
            typeof call.arguments !== 'string' || Buffer.byteLength(call.arguments) > 2 * 1024 ** 2) throw failure('PROVIDER_INVALID_RESPONSE', 'Invalid complete function call.');
        this.outputs.set(call.call_id, terminal);
      }
      const usage = terminal.usage;
      if (!usage || ![usage.input_tokens, usage.output_tokens, usage.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
        throw failure('PROVIDER_USAGE_UNKNOWN', 'Missing provider usage; reconciliation required.');
      }
      // Only expose answer text; reasoning/encrypted content stays in continuation items.
      const finalText = terminal.output.filter(item => item.type === 'message').flatMap(item => item.content || [])
        .map(part => part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '').join('');
      this.last = { response: terminal, calls, text: finalText || text,
        usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens } };
      yield { kind: 'completed', ...this.last };
    } catch (error) {
      error.providerRejectedBeforeOutput = !started;
      throw error;
    }
  }

  async request(request, options, onText = async () => {}) {
    let completed;
    for await (const event of this.events(request, options)) {
      if (event.kind === 'text') await onText(event.text);
      else completed = event;
    }
    return completed;
  }

  rememberToolResult(callId, output) {
    const response = this.outputs.get(callId);
    if (!response) throw failure('INTERNAL_ERROR', 'Unknown Responses call ID.');
    if (!this.recorded.has(response.id)) { this.continuation.push(...response.output); this.recorded.add(response.id); }
    this.continuation.push({ type: 'function_call_output', call_id: callId, output: JSON.stringify(output) });
  }

  asChatClient() {
    return { responsesSession: this, chat: { completions: { create: async (request, options) => {
      const result = await this.request(request, options);
      return { id: result.response.id, usage: result.usage, choices: [{ finish_reason: result.calls.length ? 'tool_calls' : 'stop',
        message: { role: 'assistant', content: result.text || null, tool_calls: result.calls.map(call => ({ id: call.call_id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } }] };
    } } } };
  }
}

module.exports = { ResponsesSession, configuration, content, toolsForResponses, failure };
