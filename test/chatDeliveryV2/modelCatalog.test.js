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

const gpt62 = require('../../src/config/modelCatalog20261122');
test('GPT-6.2 seeding inserts only the two requested disabled drafts, without prices or changes to active models', () => {
  const active = catalog.responsesModels.filter(model => !model.modelId.startsWith('gpt-6.2-'))
    .map(model => ({ ...model, enabled: true }));
  const operations = gpt62.plan([...active, ...catalog.retained.map(modelId => ({ modelId, enabled: true }))]);
  assert.deepEqual(operations.map(op => op.updateOne.filter.modelId), ['gpt-6.2-astra', 'gpt-6.2-sol']);
  for (const op of operations) {
    assert.equal(op.updateOne.update.$set, undefined);
    const values = op.updateOne.update.$setOnInsert;
    assert.equal(values.enabled, false);
    assert.equal(values.default, false);
    assert.equal(values.apiMode, 'responses');
    assert.equal(values.reasoningEffort, 'medium');
    assert.equal(values.inputPerM, undefined);
    assert.equal(values.outputPerM, undefined);
    assert.equal(new ChatModels(values).enabled, false);
    assert.ok(catalog.chatModelIds.includes(values.modelId));
  }
});

test('repeated GPT-6.2 seed preserves draft configuration and only inserts missing records', () => {
  const existing = { ...gpt62.additions[0], enabled: false, inputPerM: 8, outputPerM: 40, reasoningEffort: 'high' };
  const original = structuredClone(existing);
  assert.deepEqual(gpt62.plan([existing]).map(op => op.updateOne.filter.modelId), ['gpt-6.2-sol']);
  assert.deepEqual(existing, original);
  assert.deepEqual(gpt62.plan([existing, { ...gpt62.additions[1], enabled: false }]), []);
});

test('GPT-6.2 seed rejects duplicate IDs or an enabled target before any mutation', () => {
  const model = { ...gpt62.additions[0], enabled: false };
  assert.throws(() => gpt62.plan([model, { ...model }]), /Duplicate/);
  assert.throws(() => gpt62.plan([{ ...model, enabled: true }]), /not explicitly disabled/);
  assert.throws(() => gpt62.plan([{ modelId: model.modelId }]), /not explicitly disabled/);
});

const activation = require('../../src/config/gpt6Activation');
test('GPT-6 activation enables only the six requested models and supplies missing prices', () => {
  const operations = activation.plan(catalog.retained.map(modelId => ({ modelId, enabled: false })));
  assert.equal(operations.length, 6);
  assert.deepEqual(operations.map(op => op.updateOne.filter.modelId), catalog.responsesModels.map(model => model.modelId));
  for (const op of operations) {
    assert.equal(op.updateOne.update.$set.enabled, true);
    assert.equal(op.updateOne.update.$set.apiMode, 'responses');
    assert.equal(typeof op.updateOne.update.$set.inputPerM, 'number');
    assert.equal(typeof op.updateOne.update.$set.outputPerM, 'number');
  }
});

test('GPT-6 activation preserves configured prices/effort and rejects invalid settings before writing', () => {
  const configured = { modelId: 'gpt-6.2-astra', enabled: false, inputPerM: 16, outputPerM: 80, reasoningEffort: 'high' };
  const original = structuredClone(configured);
  const operation = activation.plan([configured]).find(op => op.updateOne.filter.modelId === configured.modelId);
  assert.equal(operation.updateOne.update.$set.reasoningEffort, 'high');
  assert.equal(operation.updateOne.update.$set.inputPerM, undefined);
  assert.equal(operation.updateOne.update.$set.outputPerM, undefined);
  assert.deepEqual(configured, original);
  assert.throws(() => activation.plan([configured, { ...configured }]), /Duplicate/);
  assert.throws(() => activation.plan([{ ...configured, inputPerM: NaN }]), /Invalid/);
  assert.throws(() => activation.plan([{ ...configured, reasoningEffort: 'none' }]), /Unsupported/);
});
