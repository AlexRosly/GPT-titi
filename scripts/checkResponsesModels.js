// Availability is non-billable by default. --live additionally makes paid probe calls.
const fs = require('node:fs');
const OpenAI = require('openai');
const { additions } = require('../src/config/modelCatalog202611');
const { ResponsesSession } = require('../src/services/chatDeliveryV2/responsesProvider');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
require('dotenv').config({ path: option('env-file') || '.env' });

async function main() {
  const variable = option('key-env');
  if (!variable || !/^[A-Z][A-Z0-9_]*$/.test(variable) || !process.env[variable]) throw Error('Specify --key-env=NAME containing the intended Development or Production key.');
  const label = option('label');
  if (!['development', 'production', 'configured'].includes(label)) throw Error('Specify --label=development, --label=production or --label=configured for an unclassified local key.');
  const client = new OpenAI({ apiKey: process.env[variable], maxRetries: 0, timeout: 120000 });
  const results = [];
  for (const model of additions) {
    const row = { modelId: model.modelId, label, live: process.argv.includes('--live'), available: false };
    try {
      await client.models.retrieve(model.modelId);
      row.available = true;
      if (row.live && !process.argv.includes('--files-only')) {
        const session = new ResponsesSession(client, model);
        const tool = { type: 'function', function: { name: 'verify_connection', description: 'Verify the requested model connection.',
          strict: true, parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } };
        const messages = [{ role: 'system', content: 'Викличи verify_connection з ok=true, потім коротко підтвердь українською.' },
          { role: 'user', content: 'Перевір підключення.' }];
        const first = await session.request({ model: model.modelId, messages, tools: [tool], tool_choice: { type: 'function', function: { name: tool.function.name } }, max_completion_tokens: 4096 });
        if (first.calls.length !== 1 || first.calls[0].name !== tool.function.name || JSON.parse(first.calls[0].arguments).ok !== true) throw Error('Unexpected probe function call.');
        const call = first.calls[0];
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: call.call_id, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
          { role: 'tool', tool_call_id: call.call_id, content: '{"ok":true}' });
        const second = await session.request({ model: model.modelId, messages, max_completion_tokens: 4096 });
        if (second.calls.length || !second.text.trim()) throw Error('Probe did not produce a final answer.');
        row.responseIds = [first.response.id, second.response.id];
        row.usage = [first.usage, second.usage];
        row.toolRoundTrip = true;
      }
      if (row.live && process.argv.includes('--files-only')) {
        const artifacts = require('../src/services/files/artifacts');
        row.files = [];
        for (const filename of ['probe.docx', 'probe.xlsx']) {
          const session = new ResponsesSession(client, model);
          const messages = [
            { role: 'system', content: 'Виконай коротку перевірку створення файла. Для Office повертай JSON manifest за схемою інструмента. Після результату функції дай коротке підтвердження українською.' },
            { role: 'user', content: 'Підготовлений текст OCR: контрольний код GPTITI_6429; кількість товарів — 3.' },
            { role: 'assistant', content: 'Врахую підготовлений текст документа.' },
            { role: 'user', content: `Створи ${filename}, включи контрольний код із попереднього повідомлення та кількість. Один абзац або два рядки таблиці, без зайвого вмісту.` },
          ];
          const first = await session.request({ model: model.modelId, messages, ...artifacts.toolOptions({ filename }), max_completion_tokens: 4096 });
          if (first.calls.length !== 1 || first.calls[0].name !== 'create_file') throw Error('Expected exactly one create_file call.');
          const call = first.calls[0];
          const value = JSON.parse(call.arguments);
          if (typeof value.summary !== 'string' || !value.content?.includes('GPTITI_6429')) throw Error('Prepared context was not preserved in file content.');
          const file = await artifacts.renderOutput({ filename }, value.content);
          if (file.buffer.subarray(0, 2).toString() !== 'PK') throw Error('Expected a real Office ZIP container.');
          messages.push({ role: 'assistant', content: null, tool_calls: [{ id: call.call_id, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
            { role: 'tool', tool_call_id: call.call_id, content: JSON.stringify({ ok: true, filename, bytes: file.buffer.length }) });
          const final = await session.request({ model: model.modelId, messages, max_completion_tokens: 4096 });
          if (final.calls.length || !final.text.trim()) throw Error('File workflow did not produce a final answer.');
          row.files.push({ filename, bytes: file.buffer.length, mimetype: file.mimetype, contextPreserved: true,
            responseIds: [first.response.id, final.response.id], usage: [first.usage, final.usage] });
        }
      }
    } catch (error) {
      row.error = { status: error.status || null, code: error.protocolError?.code || error.code || 'PROBE_FAILED',
        type: error.name, connectionCode: error.cause?.code || null };
      process.exitCode = 1;
    }
    results.push(row);
    console.log(JSON.stringify(row));
  }
  if (option('report')) fs.writeFileSync(option('report'), JSON.stringify({ label, checkedAt: new Date().toISOString(), results }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
