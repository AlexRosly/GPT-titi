const test=require('node:test'),assert=require('node:assert/strict');
const {tool,validate,decode,diagnostic}=require('../../src/services/browser/actions');
const seeds=['https://example.com/'];
const obs={controls:[{kind:'follow',ref:'b1'},{kind:'search',ref:'b2'},{kind:'tab',ref:'b3'},{kind:'expand',ref:'b4'}]};
const response=(value,finish='tool_calls')=>({choices:[{finish_reason:finish,message:{tool_calls:[{type:'function',function:{name:'browse',arguments:JSON.stringify(value)}}]}}]});
const reason=(fn,expected)=>assert.throws(fn,e=>e.browserDiagnostic?.reason===expected);
test('strict tool describes nullable required fields and forbids unknown keys',()=>{
  assert.equal(tool.function.strict,true);const schema=tool.function.parameters;
  assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,Object.keys(schema.properties));
  for(const key of ['ref','query','url'])assert.deepEqual(schema.properties[key].type,['string','null']);
});
test('all supported kinds normalize nullable slots to canonical runner actions',()=>{
  for(const a of [{kind:'open',url:seeds[0]},{kind:'follow',ref:'b1'},{kind:'search',ref:'b2',query:'Київ'},
    {kind:'tab',ref:'b3'},{kind:'expand',ref:'b4'},{kind:'scroll'},{kind:'back'},{kind:'done'}]){
    const wire={ref:null,query:null,url:null,...a};assert.deepEqual(decode(response(wire),obs,seeds).action,a);
    assert.deepEqual(validate(a,obs,seeds).action,a);
  }
});
test('legacy empty unused strings accepted; filled irrelevant arguments rejected',()=>{
  assert.deepEqual(validate({kind:'follow',ref:'b1',url:'',query:''},obs,seeds).action,{kind:'follow',ref:'b1'});
  reason(()=>validate({kind:'follow',ref:'b1',url:seeds[0]},obs,seeds),'UNUSED_ARGUMENT_NOT_EMPTY');
  reason(()=>validate({kind:'done',query:'secret'},obs,seeds),'UNUSED_ARGUMENT_NOT_EMPTY');
});
test('stop finish accepted only with a complete single independently validated browse call',()=>{
  const result=decode(response({kind:'follow',ref:'b1'},'stop'),obs,seeds);
  assert.equal(result.diagnostic.normalizedFinishReason,true);
  reason(()=>decode({choices:[{finish_reason:'stop',message:{content:'done'}}]},obs,seeds),'TOOL_CALL_COUNT');
});
test('truncation, content filtering, refusal, multiple calls and wrong functions never execute',()=>{
  for(const finish of ['length','content_filter','function_call',undefined]){
    const r=response({kind:'done'});r.choices[0].finish_reason=finish;reason(()=>decode(r,obs,seeds),'UNSAFE_FINISH_REASON');
  }
  const multi=response({kind:'done'});multi.choices[0].message.tool_calls.push(multi.choices[0].message.tool_calls[0]);reason(()=>decode(multi,obs,seeds),'TOOL_CALL_COUNT');
  const wrong=response({kind:'done'});wrong.choices[0].message.tool_calls[0].function.name='execute';reason(()=>decode(wrong,obs,seeds),'UNEXPECTED_TOOL');
  const refused=response({kind:'done'});refused.choices[0].message.refusal='private reason';reason(()=>decode(refused,obs,seeds),'PROVIDER_REFUSAL');
});
test('argument parse errors distinguish shape, malformed JSON and oversized arguments',()=>{
  for(const [value,expected] of [[null,'ARGUMENTS_NOT_OBJECT'],[[],'ARGUMENTS_NOT_OBJECT'],['text','ARGUMENTS_NOT_OBJECT'],[{kind:'toString'},'UNKNOWN_ACTION'],[{kind:'__proto__'},'UNKNOWN_ACTION'],[{kind:'done',selector:'secret'},'UNKNOWN_ARGUMENT_FIELD']])reason(()=>decode(response(value),obs,seeds),expected);
  const r=response({kind:'done'});const fn=r.choices[0].message.tool_calls[0].function;
  fn.arguments='{';reason(()=>decode(r,obs,seeds),'ARGUMENTS_INVALID_JSON');
  fn.arguments={};reason(()=>decode(r,obs,seeds),'ARGUMENTS_NOT_STRING');
  fn.arguments='x'.repeat(32769);reason(()=>decode(r,obs,seeds),'ARGUMENTS_TOO_LARGE');
});
test('missing refs, wrong control types, unsafe URLs and invalid searches remain blocked',()=>{
  reason(()=>validate({kind:'follow'},obs,seeds),'MISSING_OR_INVALID_ARGUMENT');
  reason(()=>validate({kind:'tab',ref:'b1'},obs,seeds),'CONTROL_NOT_OBSERVED_OR_WRONG_KIND');
  reason(()=>validate({kind:'follow',ref:'b9'},obs,seeds),'CONTROL_NOT_OBSERVED_OR_WRONG_KIND');
  reason(()=>validate({kind:'open',url:'http://127.0.0.1/'},obs,seeds),'URL_REJECTED');
  reason(()=>validate({kind:'open',url:'https://other.example/'},obs,seeds),'URL_NOT_A_SEED');
  for(const query of ['x'.repeat(201),'a\nb'])reason(()=>validate({kind:'search',ref:'b2',query},obs,seeds),'SEARCH_QUERY_INVALID');
});
test('rejection diagnostic never includes private arguments, URLs, labels or unknown keys',()=>{
  const secret='PRIVATE_CUSTOMER_SecretQuery';let error;
  try{decode(response({kind:'done',query:secret}),{controls:[{label:secret}]},seeds);}catch(e){error=e;}
  const d=diagnostic({turnId:'turn',attempt:1,modelId:'model',browserState:{calls:2}},error.browserDiagnostic);
  assert.equal(d.reason,'UNUSED_ARGUMENT_NOT_EMPTY');assert.equal(d.field,'query');assert.equal(d.call,2);
  assert.ok(!JSON.stringify(d).includes(secret));assert.ok(!JSON.stringify(d).includes('example.com'));
});
