const test=require('node:test'),assert=require('node:assert/strict'),pino=require('pino');
const redact=require('../../src/utils/logRedaction');
test('HTTP log redaction hides request credentials and response cookies before transport',()=>{
  let output='';const log=pino({redact},{write:s=>{output+=s;}});
  log.info({req:{headers:{authorization:'SECRET_AUTH',cookie:'SECRET_REFRESH','proxy-authorization':'SECRET_PROXY','x-api-key':'SECRET_API',host:'example.com'}},res:{headers:{'set-cookie':'SECRET_NEW'}},err:{headers:{'set-cookie':'SECRET_PROVIDER'}}},'request completed');
  assert.ok(!output.includes('SECRET_'));assert.match(output,/example.com/);assert.match(output,/REDACTED/);
});
