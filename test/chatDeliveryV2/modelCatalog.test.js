const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../../src/config/modelCatalog202611');
const ChatModels = require('../../src/models/chatModels');

test('migration disables only requested legacy IDs; retained models and historical references are untouched', () => {
  const rows = [...catalog.retained.map(modelId => ({ modelId, enabled: true })),
    ...['o1', 'o3-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-5.1', 'gpt-4o-2024-08-06'].map(modelId => ({ modelId, enabled: true })),
    { modelId: 'whisper-1', enabled: true }, { modelId: 'another-provider', enabled: true }];
  const operations = catalog.plan(rows);
  assert.equal(operations.filter(op => op.updateOne.update.$set.enabled === false && !op.updateOne.upsert).length, 6);
  for (const id of [...catalog.retained, 'whisper-1', 'another-provider']) assert.equal(operations.some(op => op.updateOne.filter.modelId === id), false);
  assert.equal(operations.some(op => op.deleteOne || op.deleteMany), false);
});

test('four exact model IDs are seeded disabled, with distinct reasoning settings and no invented prices', () => {
  const operations = catalog.plan([]);
  assert.deepEqual(operations.map(op => op.updateOne.filter.modelId), catalog.additions.map(m => m.modelId));
  for (const op of operations) {
    const values = op.updateOne.update.$set;
    assert.equal(values.apiMode, 'responses');
    assert.equal(values.enabled, false);
    assert.equal(values.inputPerM, undefined);
    const doc = new ChatModels(values);
    assert.equal(doc.apiMode, 'responses');
    assert.equal(doc.reasoningEffort, values.reasoningEffort);
  }
});

test('catalog fails before writes when duplicate IDs or already-enabled new entries need manual review', () => {
  assert.throws(() => catalog.plan([{ modelId: 'gpt-5.4' }, { modelId: 'gpt-5.4' }]), /Duplicate/);
  assert.throws(() => catalog.plan([{ modelId: 'gpt-6-luna', enabled: true }]), /already enabled/);
});

test('legacy models default to the existing API path', () => {
  assert.equal(new ChatModels({ modelId: 'gpt-5.4' }).apiMode, 'chat_completions');
});
