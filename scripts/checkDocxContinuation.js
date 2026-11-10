// Offline, read-only comparison. No provider request, database, document content
// or filename is emitted. Estimates are NOT actual charged provider usage.
const fs = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const textInput = require('../src/services/files/textInput');
const officeInput = require('../src/services/files/officeInput');
const office = require('../src/services/files/office');
const artifacts = require('../src/services/files/artifacts');
const compute = require('../src/services/computation/policy');
const policy = require('../src/services/docx/policy');
const continuation = require('../src/services/docx/continuation');
const sources = require('../src/services/files/sourceParts');
const { estimate } = require('../src/services/computation/budget');

async function measure(buffer, targets, pricing, spentUsd) {
  const start = performance.now(), cpu = process.cpuUsage();
  const text = await officeInput.extract(buffer, 'docx');
  const file = { _id: '012345678901234567890123', originalName: 'source.docx', mimetype: office.mimes.docx };
  const files = [{ fileId: file._id, name: file.originalName, size: buffer.length }];
  const system = 'You are a helpful assistant. ' + textInput.instructions + ' ' + artifacts.fileSystemInstructions +
    ' ' + compute.instructions({}) + ' Office exports follow: ' + office.instructions +
    '\nCOMPUTATION_FILES: ' + JSON.stringify(files) + ' ' + policy.instructions;
  let before = [{ role: 'system', content: system }, { role: 'user', content: [
    { type: 'text', text: 'Extend only signature lines across their rows. Preserve text, spacing and all other formatting. Return an edited DOCX copy.' },
    sources.mark(textInput.part(file, text), file),
  ] }];
  let after = before, state = { files: [], executionMs: 0 }, steps = [];
  // Use identical current tool contracts in both columns to isolate the context
  // change. Earlier production schemas/history can produce different counts.
  const tools = [compute.tool, ...policy.tools];
  for (const target of targets) {
   let offset = 0;
   do {
    if (steps.length >= compute.limits().runs) throw Error('Inspection plan exceeds the existing action limit');
    const args = policy.parse('inspect_docx', JSON.stringify({ fileId: file._id, target, offset }));
    const call = { id: 'inspect_' + steps.length, type: 'function', function: { name: 'inspect_docx', arguments: JSON.stringify(args) } };
    const stepStart = performance.now();
    const { inspection } = await require('../src/services/docx/process').run(buffer, 'inspect_docx', args, new AbortController().signal);
    const workerWallMs = Math.round(performance.now() - stepStart);
    state = { ...state, docxInspections: { [file._id]: inspection.checksum } };
    const result = { ok: true, text: JSON.stringify(inspection), truncated: false };
    const assistant = { role: 'assistant', content: null, tool_calls: [call] };
    before = [...before, assistant, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ...result, files: [], executionMs: 0 }) }];
    after = [...continuation.compact(after, state), assistant, { role: 'tool', tool_call_id: call.id, content: JSON.stringify(continuation.toolResult(call, result, state)) }];
    const a = estimate(before, tools, pricing), b = estimate(after, tools, pricing);
    steps.push({ target, offset, inspectionItems: inspection.items.length, nextOffset: inspection.nextOffset,
      inspectionBytes: Buffer.byteLength(result.text), workerWallMs,
      before: { contextBytes: Buffer.byteLength(JSON.stringify(before)), ...a, projectedUsdAtGivenSpend: spentUsd + a.usd },
      after: { contextBytes: Buffer.byteLength(JSON.stringify(after)), ...b, projectedUsdAtGivenSpend: spentUsd + b.usd } });
    offset = inspection.nextOffset;
   } while (offset !== null);
  }
  const used = process.cpuUsage(cpu);
  return { version: 1, offlineOnly: true, pricing, givenSpentUsd: spentUsd, limitUsd: compute.limits().usd,
    fileBytes: buffer.length, extractedBytes: Buffer.byteLength(text), remainingActions: compute.limits().runs - steps.length, steps,
    processMeasurement: { wallMs: Math.round(performance.now() - start), cpuUserMs: Math.round(used.user / 1000),
      cpuSystemMs: Math.round(used.system / 1000), maxRssKiB: process.resourceUsage().maxRSS,
      note: 'Whole CLI process including parser workers and tokenizer initialization; not isolated production worker RSS or model latency.' } };
}

if (require.main === module) (async () => {
  const [filename, ...targets] = process.argv.slice(2);
  if (!filename || !targets.length) throw Error('Usage: node scripts/checkDocxContinuation.js FILE.docx tables table0[,table1,...]');
  if ((await fs.stat(filename)).size > officeInput.FILE_BYTES) throw Error('DOCX_EDIT_FILE_LIMIT');
  // Defaults match the reported production diagnostic. Rates can be overridden
  // for another model; this script neither reads .env nor calls a provider.
  const pricing = { inputPerM: Number(process.env.DOCX_BENCH_INPUT_PER_M ?? 5), outputPerM: Number(process.env.DOCX_BENCH_OUTPUT_PER_M ?? 30), tokenValueUsd: 0.00001 };
  const spentUsd = Number(process.env.DOCX_BENCH_SPENT_USD ?? 0.042745);
  if (!Number.isFinite(spentUsd) || spentUsd < 0) throw Error('Invalid benchmark spend');
  if (!continuation.enabled()) throw Error('Enable DOCX continuation for the after column');
  console.log(JSON.stringify(await measure(await fs.readFile(filename), targets, pricing, spentUsd), null, 2));
})().catch(error => { console.error(error.fileError || error.message); process.exitCode = 1; });

module.exports = { measure };
