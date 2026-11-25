// A deliberate live provider evaluation. It never executes model-selected websites.
const assert = require('node:assert/strict');
const { parseArgs } = require('node:util');
const cases = require('../test/web/sourceCases');
const source = require('../src/services/web/sourceTool');
const { ResponsesSession, configuration } = require('../src/services/chatDeliveryV2/responsesProvider');

async function main() {
  const { values } = parseArgs({ options: {
    live: { type:'boolean', default:false }, model: {type:'string'}, api: {type:'string',default:'chat_completions'},
    effort: {type:'string',default:'low'}, locales: {type:'string'},
  } });
  const languages = values.locales && new Set(values.locales.split(',').map(item => item.trim()));
  if (languages) for (const language of languages)
    assert.ok(cases.some(test => test.locale === language), 'Unknown fixture locale: ' + language);
  const selected = cases.filter(test => !languages || languages.has(test.locale));
  console.log(selected.length + ' cases; ' + new Set(selected.map(test => test.locale)).size + ' locales.');
  if (!values.live) {
    console.log('Preview only. Add --live --model=MODEL and the corresponding --api to call the provider.');
    return;
  }
  require('dotenv').config({quiet:true});
  assert.ok(values.model && process.env.OPENAI_API_KEY, 'Set OPENAI_API_KEY and --model.');
  const ai = new (require('openai'))({ maxRetries:0, timeout:60000 });
  const config = configuration({modelId:values.model,apiMode:values.api,reasoningEffort:values.effort});
  let errors = 0, providerCalls = 0;
  for (const {locale, scenario, message, expected} of selected) {
    try {
      let actual = [];
      const allowed = source.candidates(message);
      if (allowed.size) {
        const messages = [{role:'system',content:'You are a helpful assistant. ' + source.instructions},{role:'user',content:message}];
        const request = { model:values.model,messages,tools:[source.tool],tool_choice:'auto',parallel_tool_calls:false,max_completion_tokens:1000 };
        providerCalls++;
        const reply = config.apiMode === 'responses'
          ? await new ResponsesSession(ai,config).asChatClient().chat.completions.create(request)
          : await ai.chat.completions.create(request);
        const choice = reply.choices?.[0];
        if (!choice || !['stop','tool_calls'].includes(choice.finish_reason)) throw Error('Incomplete model decision');
        const calls = choice.message?.tool_calls || [];
        if (calls.length) {
          if (calls.length !== 1 || calls[0].function.name !== source.name) throw Error('Unexpected function selection');
          actual = source.resolve(calls[0].function.arguments, allowed);
        }
      }
      assert.deepEqual(actual, expected);
      console.log('PASS',locale,scenario);
    } catch (error) {
      errors++;
      console.error('FAIL',locale,scenario,error.message);
      if ([401,403,404,429].includes(error.status)) break;
    }
  }
  console.log('Provider calls: ' + providerCalls + '. Failures: ' + errors);
  if (errors) process.exitCode = 1;
}
main().catch(error => {console.error(error.message);process.exitCode=1;});
