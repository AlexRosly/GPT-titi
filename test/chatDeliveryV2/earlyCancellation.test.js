const test = require('node:test');
const assert = require('node:assert/strict');
const early = require('../../src/services/chatDeliveryV2/earlyCancellation');
const turn = () => ({ providerConfig: { apiMode: 'chat_completions' }, cancelRequestedAt: new Date(),
  providerStartedAt: new Date(), lastSeq: 0, partialContent: '' });
test('policy is opt-in and unrecognised values retain manual settlement', () => {
  const old = process.env.CHAT_EARLY_CANCEL_UNKNOWN_USAGE_POLICY;
  try {
    for (const value of ['', 'manual', 'true', 'waive', 'PLATFORM_COVERS_UNKNOWN']) {
      process.env.CHAT_EARLY_CANCEL_UNKNOWN_USAGE_POLICY = value;
      assert.equal(early.policy(), 'manual');
    }
    process.env.CHAT_EARLY_CANCEL_UNKNOWN_USAGE_POLICY = early.COVER_UNKNOWN;
    assert.equal(early.policy(), early.COVER_UNKNOWN);
  } finally {
    if (old === undefined) delete process.env.CHAT_EARLY_CANCEL_UNKNOWN_USAGE_POLICY;
    else process.env.CHAT_EARLY_CANCEL_UNKNOWN_USAGE_POLICY = old;
  }
});
test('final usage must contain consistent integer counts, including a genuine zero result', () => {
  assert.deepEqual(early.readInitialUsage({ prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 }),
    { promptTokens: 20, completionTokens: 3, totalTokens: 23 });
  assert.deepEqual(early.readInitialUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  for (const u of [null, {}, { prompt_tokens: 20 }, { prompt_tokens: 20, completion_tokens: 3, total_tokens: 20 },
    { prompt_tokens: '20', completion_tokens: 3, total_tokens: 23 },
    { prompt_tokens: -1, completion_tokens: 3, total_tokens: 2 }]) assert.equal(early.readInitialUsage(u), null);
});
test('coverage is limited to an early cancelled initial call with no delivered output', () => {
  assert.equal(early.canCoverUnknown(turn()), true);
  for (const change of [
    { providerConfig: { apiMode: 'responses' } }, { providerConfig: null }, { cancelRequestedAt: null },
    { providerStartedAt: null }, { computeState: { pending: false } }, { responseState: { pending: true } },
    { browserState: {} }, { webPlan: {} }, { providerResult: {} }, { assistantMessage: 'done' },
    { lastSeq: 1 }, { partialContent: 'Already delivered text' }, { initialProviderUsage: {} },
  ]) assert.equal(early.canCoverUnknown({ ...turn(), ...change }), false, JSON.stringify(change));
});
test('cancelled status remains USER_CANCELLED for both pending and completed settlement', () => {
  assert.equal(early.cancellationError(true).code, 'USER_CANCELLED');
  assert.match(early.cancellationError(true).message, /needs review/);
  assert.equal(early.cancellationError(true).retryable, false);
  assert.match(early.cancellationError(false).message, /complete/);
});
