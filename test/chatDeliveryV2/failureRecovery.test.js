const test = require('node:test'), assert = require('node:assert/strict');
const { partialResult, diagnostic } = require('../../src/services/chatDeliveryV2/failureRecovery');
const usage = { promptTokens: 12, completionTokens: 4, totalTokens: 16 };
const turn = () => ({ responseState: { pending: false, usage, partialData: {} },
  computeState: { kind: 'document', pending: false, usage, files: [], runs: 1, executionMs: 10 } });
test('known document error keeps its exact code and only completed files', () => {
  const result = partialResult(turn(), 'COMPUTE_BUDGET_LIMIT');
  assert.equal(result.computation.status, 'partial');assert.equal(result.computation.reason, 'COMPUTE_BUDGET_LIMIT');
  assert.deepEqual(result.usage, usage);assert.deepEqual(result.computation.files, []);
});
test('unknown usage, cancellation, active jobs and conflicting accounting cannot auto-settle', () => {
  const cases = [t => t.responseState.pending = true, t => t.computeState.pending = true,
    t => delete t.responseState.pending, t => delete t.computeState.pending,
    t => t.cancelRequestedAt = new Date(), t => t.providerResult = {},
    t => t.computeState.documentJob = { active: true }, t => t.computeState.usage = { ...usage, totalTokens: 17 },
    t => t.responseState.usage = { promptTokens: 12, completionTokens: NaN, totalTokens: 16 }];
  for (const mutate of cases) {const t = structuredClone(turn());mutate(t);assert.equal(partialResult(t,'INTERNAL_ERROR'),null);}
  assert.equal(partialResult({},'INTERNAL_ERROR'),null);
});
test('failure diagnostics omit arbitrary messages, provider content and credentials', () => {
  const d = diagnostic({ message:'secret-file-data',stack:'secret-stack',code:'secret\ntext',status:503,
    protocolError:{code:'PROVIDER_RESPONSE_INCOMPLETE'},providerResponse:{status:'incomplete',
      incomplete_details:{reason:'max_output_tokens'},output:[{text:'secret-output'}]},headers:{authorization:'secret-token'} },turn());
  assert.equal(d.incompleteReason,'max_output_tokens');assert.equal(d.providerHttpStatus,503);
  assert.equal(d.providerCode,null);assert.doesNotMatch(JSON.stringify(d),/secret/);
});
