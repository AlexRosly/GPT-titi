const { normalize, fail } = require('../web/policy');
const fields = Object.freeze({open:['url'],follow:['ref'],expand:['ref'],tab:['ref'],search:['ref','query'],scroll:[],back:[],done:[]});
const known = ['kind','ref','query','url'];
const tool = {type:'function',function:{name:'browse',strict:true,
  description:'Choose one safe action. open uses a supplied seed URL; follow/expand/tab use an observed ref; search uses ref and query; scroll/back/done use no arguments. Set every unused ref/query/url field to null. Never invent references or execute arbitrary code.',
  parameters:{type:'object',additionalProperties:false,properties:{
    kind:{type:'string',enum:Object.keys(fields)},
    ref:{type:['string','null'],description:'Exact observed control ref for follow, expand, tab or search; otherwise null.'},
    query:{type:['string','null'],description:'Public site search text, at most 200 characters, only for search; otherwise null.'},
    url:{type:['string','null'],description:'An exact user-supplied seed URL, only for open; otherwise null.'}
  },required:known}}};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));
const reject = (reason, code = 'BROWSER_INVALID_ACTION', details = {}) => {
  throw Object.assign(fail(code), {browserDiagnostic:{reason,...details}});
};
function validate(value, observation, seeds) {
  if (!plain(value)) reject('ARGUMENTS_NOT_OBJECT');
  const {kind} = value;
  if (typeof kind !== 'string' || !Object.hasOwn(fields,kind)) reject('UNKNOWN_ACTION');
  const keys = Object.keys(value);
  if (keys.some(k=>!known.includes(k))) reject('UNKNOWN_ARGUMENT_FIELD',undefined,{kind});
  const result = {kind}, normalizedFields = [];
  for (const key of known.slice(1)) {
    if (!fields[kind].includes(key)) {
      if (!Object.hasOwn(value,key)) continue;
      if (value[key] !== null && value[key] !== '') reject('UNUSED_ARGUMENT_NOT_EMPTY',undefined,{kind,field:key});
      normalizedFields.push(key); continue;
    }
    if (typeof value[key] !== 'string' || !value[key].trim()) reject('MISSING_OR_INVALID_ARGUMENT',undefined,{kind,field:key});
    result[key] = value[key];
  }
  if (kind === 'open') {
    let url;
    try {url=normalize(result.url);} catch {reject('URL_REJECTED','BROWSER_ACTION_BLOCKED',{kind});}
    if (!seeds.includes(url)) reject('URL_NOT_A_SEED','BROWSER_ACTION_BLOCKED',{kind});
    result.url=url;
  } else if (fields[kind].includes('ref')) {
    if (!observation?.controls?.some(c=>c.ref===result.ref && c.kind===kind)) reject('CONTROL_NOT_OBSERVED_OR_WRONG_KIND','BROWSER_ACTION_BLOCKED',{kind});
    if (kind==='search' && (result.query.length>200 || /[\x00-\x1f]/.test(result.query))) reject('SEARCH_QUERY_INVALID',undefined,{kind});
  }
  return {action:result,normalizedFields};
}
function decode(response, observation, seeds) {
  const choices=response?.choices;
  const choice=Array.isArray(choices) && choices.length===1 ? choices[0] : null;
  const finishReason=['tool_calls','stop','length','content_filter','function_call'].includes(choice?.finish_reason) ? choice.finish_reason : 'other';
  const calls=choice?.message?.tool_calls;
  const meta={finishReason,toolCount:Array.isArray(calls)?Math.min(calls.length,100):0};
  try {
    if (!choice) reject('CHOICE_COUNT');
    if (!['tool_calls','stop'].includes(choice.finish_reason)) reject('UNSAFE_FINISH_REASON');
    if (choice.message?.refusal) reject('PROVIDER_REFUSAL');
    if (!Array.isArray(calls) || calls.length!==1) reject('TOOL_CALL_COUNT');
    const call=calls[0];
    if (!call || (call.type !== undefined && call.type !== 'function') || call.function?.name!=='browse') reject('UNEXPECTED_TOOL');
    const raw=call.function.arguments;
    if (typeof raw !== 'string') reject('ARGUMENTS_NOT_STRING');
    meta.argumentBytes=Buffer.byteLength(raw);
    if (meta.argumentBytes>32768) reject('ARGUMENTS_TOO_LARGE');
    let value;try{value=JSON.parse(raw);}catch{reject('ARGUMENTS_INVALID_JSON');}
    const result=validate(value,observation,seeds);
    return {...result,diagnostic:{...meta,reason:'ACCEPTED',kind:result.action.kind,
      normalizedFields:result.normalizedFields,normalizedFinishReason:finishReason==='stop'}};
  } catch(error) {
    if (error.browserDiagnostic) error.browserDiagnostic={...meta,...error.browserDiagnostic};
    throw error;
  }
}
// Never include raw arguments, labels, URLs, provider messages, screenshots or query text.
function diagnostic(turn, details) {
  return {turnId:turn.turnId,attempt:turn.attempt,modelId:turn.modelId,
    call:turn.browserState?.calls || 0,...details};
}
module.exports={tool,validate,decode,diagnostic};
