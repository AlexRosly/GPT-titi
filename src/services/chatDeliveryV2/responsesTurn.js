const { ResponsesSession, failure } = require('./responsesProvider');

// Validate complete function JSON before delegating to existing policy/ownership validators.
function validate(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(s => validate(value, s));
  if (schema.oneOf) return schema.oneOf.filter(s => validate(value, s)).length === 1;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && ![schema.type].flat().some(t => t === type || t === 'integer' && Number.isSafeInteger(value))) return false;
  if (type === 'object') {
    if ((schema.required || []).some(k => !Object.hasOwn(value, k))) return false;
    for (const key of Object.keys(value)) {
      if (schema.properties?.[key]) { if (!validate(value[key], schema.properties[key])) return false; }
      else if (schema.additionalProperties === false) return false;
    }
  }
  if (type === 'array' && (value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity) ||
    schema.items && value.some(v => !validate(v, schema.items)))) return false;
  if (type === 'string' && (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? Infinity) ||
    schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
  if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

const mappedUsage = usage => ({ promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens });
const addUsage = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, a[k] + b[k]]));

async function run({ turn, token, model, messages, fileTools, computeFiles, exactFiles, client, signal,
  onText, save, onResponseId, providerProgress, maxOutputTokens }) {
  const artifacts = require('../files/artifacts');
  const compute = require('../computation/policy');
  const accounting = require('../computation/accounting');
  const exact = require('../files/exactTranscription');
  const docxContinuation = require('../docx/continuation');
  let transcript = messages.map(m => ({ ...m }));
  const session = new ResponsesSession(client, model, { onResponseId });
  const allowed = new Map((fileTools.tools || []).map(t => [t.function.name, t.function]));
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let assistantText = '', exactText = null, fileOutput = {}, release, cleanupUnconfirmed = false;
  let createdFile = false;
  const maxCalls = 6;
  const deadline = Date.now() + (allowed.has('run_python') ? compute.limits().durationMs : 300000);
  const saveCompute = async computeState => { await save({ computeState }); turn.computeState = computeState; };
  const checkpoint = async (pending, calls) => save({ responseState: { pending, calls, usage,
    partialData: { assistantText: exactText ?? assistantText, ...fileOutput } } });
  try {
    for (let step = 0; step < maxCalls; step++) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw failure('PROVIDER_RESPONSE_INCOMPLETE', 'Tool workflow deadline exceeded.');
      const toolOptions = { ...fileTools, ...(step ? { tool_choice: 'auto' } : {}) };
      if (createdFile) toolOptions.tools = (fileTools.tools || []).filter(t => t.function.name !== 'create_file');
      if (turn.computeState) {
        await accounting.begin(turn, token, transcript, toolOptions.tools);
      }
      await checkpoint(true, step + 1);
      let response;
      try {
        response = await session.request({ model: turn.modelId, messages: transcript, ...toolOptions,
          ...(maxOutputTokens ? { max_completion_tokens: maxOutputTokens } : {}),
          ...(turn.computeState ? { max_completion_tokens: compute.limits().outputTokens } : {}) },
        { signal, timeout: Math.max(1, Math.min(deadline - Date.now(), 300000)) }, async delta => {
          assistantText += delta;
          if (!turn.outputFile && !exactFiles.length) await onText(delta);
        });
      } catch (error) {
        if (step === 0 && error.providerRejectedBeforeOutput) providerProgress.rejectedBeforeOutput = true;
        if (turn.computeState && error.providerRejectedBeforeOutput && [400, 401, 403, 404, 422, 429].includes(error.status)) {
          await accounting.rejected(turn, token);
        }
        throw error;
      }
      usage = addUsage(usage, mappedUsage(response.usage));
      if (turn.computeState) await accounting.received(turn, token, response.usage);
      await checkpoint(false, step + 1);
      if (!response.calls.length) {
        if (turn.outputFile && !fileOutput.artifact && !fileOutput.artifactError) fileOutput = { artifactError: 'INVALID_FILE_OUTPUT' };
        return { assistantText: exactText ?? (assistantText || response.text), usage, ...fileOutput,
          ...(turn.computeState ? { computation: { status: turn.computeState.lastActionFailed ? 'partial' : 'completed', kind: turn.computeState.kind, reason: turn.computeState.lastActionError, files: turn.computeState.files,
            runs: turn.computeState.runs, executionMs: turn.computeState.executionMs } } : {}) };
      }
      const calls = response.calls.map(c => ({ id: c.call_id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
      // prepare() restores ALL original output items (including reasoning) for this group.
      transcript.push({ role: 'assistant', content: null, tool_calls: calls });
      for (const call of calls) {
        signal.throwIfAborted();
        let result;
        try {
          const definition = allowed.get(call.function.name);
          if (!definition) throw failure('TOOL_NOT_AVAILABLE', 'Tool is not enabled for this request.');
          let args;
          try { args = JSON.parse(call.function.arguments); } catch { throw failure('INVALID_TOOL_ARGUMENTS', 'Invalid function JSON.'); }
          if (!validate(args, definition.parameters)) throw failure('INVALID_TOOL_ARGUMENTS', 'Function arguments do not match the schema.');
          if (call.function.name === 'create_file') {
            if (exactText !== null) throw failure('TOOL_CONFLICT', 'Saved transcription is already selected for this turn.');
            if (createdFile) throw failure('FILE_OUTPUT_LIMIT', 'Only one create_file result may be attached per turn.');
            const collector = artifacts.collector({ optional: !turn.outputFile, model });
            collector.add({ choices: [{ delta: { tool_calls: [{ ...call, index: 0 }] }, finish_reason: 'tool_calls' }] });
            const output = collector.finish();
            if (output.artifactError) throw require('../files/validation').fail(output.artifactError);
            const spec = turn.outputFile || { filename: output.artifact.filename };
            await artifacts.renderOutput(spec, output.artifact.content);
            fileOutput = output;
            createdFile = true;
            result = { ok: true, filename: spec.filename, status: 'prepared', note: 'The server attaches the validated file when this turn commits. Do not invent download URLs.' };
          } else if (call.function.name === exact.NAME) {
            if (createdFile) throw failure('TOOL_CONFLICT', 'A downloadable file is already prepared for this turn.');
            exactText = await exact.render(turn.user, { ids: args.fileIds }, exactFiles);
            result = { ok: exactText !== exact.failure, status: 'prepared', note: 'The server inserts the saved extraction verbatim. Do not rewrite it.' };
          } else if (compute.accepts(call.function.name,model)) {
            if (!turn.computeState) {
              release = await require('../computation/leases').acquire(turn.user);
              await saveCompute({ ...(require('../docx/policy').isTool(call.function.name)?{kind:'document'}:{}), calls: 0, pending: false, usage, initialUsage: usage,
                runs: 0, executionMs: 0, files: [], stage: 'preparing' });
            }
            const executed = await require('../computation/execute').run({ turn, token, model, call, available: computeFiles,
              transcript, initialUsage: turn.computeState.initialUsage, save: saveCompute, signal,
              completionAllowed: calls.length === 1 && !turn.outputFile && !createdFile && exactText === null });
            if (executed.deferred) return executed;
            signal.throwIfAborted();
            const completed = docxContinuation.completion(turn);
            if (completed) return completed;
            transcript = docxContinuation.compact(transcript, executed.next);
            result = docxContinuation.toolResult(call, executed.result, executed.next);
          } else throw failure('TOOL_NOT_AVAILABLE', 'No handler for this function.');
        } catch (error) {
          if (error.cleanupUnconfirmed) { cleanupUnconfirmed = true; throw error; }
          if (error.staleLease || signal.aborted || !error.protocolError && !error.fileError) throw error;
          const code = error.fileError || error.protocolError.code;
          if (turn.computeState && compute.accepts(call.function.name,model)) await saveCompute({...turn.computeState,lastActionFailed:true,lastActionError:code});
          if (call.function.name === 'create_file' && !createdFile) fileOutput = { artifactError: code };
          result = { ok: false, error: code };
        }
        transcript.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      await checkpoint(false, step + 1);
    }
    throw failure('PROVIDER_RESPONSE_INCOMPLETE', 'Tool call limit exceeded before final answer.');
  } finally {
    if (release && !cleanupUnconfirmed) await release().catch(() => console.warn('COMPUTE_LEASE_RELEASE_FAILED', { turnId: turn.turnId, attempt: turn.attempt }));
  }
}

module.exports = { run, validate };
