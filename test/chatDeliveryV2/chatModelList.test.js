const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatModels } = require('../../src/models');
const getChatModels = require('../../src/controllers/user/getChatModels');
const { responsesModels: additions, retained } = require('../../src/config/modelCatalog202611');

async function request(t, records) {
  let status, body;
  t.mock.method(ChatModels, 'find', (query, projection) => ({ lean: async () => {
    assert.deepEqual(query.$or, [{ enabled: true }, { modelId: { $in: additions.map(m => m.modelId) } }]);
    assert.deepEqual(query.modelId.$in, [...retained, ...additions.map(m => m.modelId)]);
    return records.filter(row => query.modelId.$in.includes(row.modelId) && query.$or.some(branch =>
      branch.enabled === true ? row.enabled === true : branch.modelId.$in.includes(row.modelId)))
      .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => projection[key] !== 0)));
  } }));
  await getChatModels({}, { status(code) { status = code; return this; }, json(value) { body = value; } });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  return body.chatModels;
}

test('chat picker excludes enabled legacy variants, Realtime and tool cards', async t => {
  const selected = [...retained, ...additions.map(m => m.modelId)].map(modelId => ({ modelId, enabled: true, label: modelId, inputPerM: 1, outputPerM: 2 }));
  const other = ['o1', 'o1-mini', 'o3-mini', 'gpt-5.1-mini', 'gpt-4o-realtime', 'gpt-5.1-realtime',
    'smart-search', 'image-create-hd', 'image-create-fast', 'voice-to-text', 'text-to-voice', 'unrelated-model']
    .map(modelId => ({ modelId, enabled: true }));
  const models = await request(t, [...other, ...selected]);
  assert.deepEqual(models.map(m => m.modelId), selected.map(m => m.modelId));
  assert.equal(models.every(m => m.inputPerM === undefined && m.outputPerM === undefined), true);
  assert.equal(models.every(m => m.label === m.modelId), true);
});

test('all six GPT-6 drafts are visible with their actual disabled status', async t => {
  const records = [...retained.map(modelId => ({ modelId, enabled: true })),
    ...additions.map(model => ({ ...model, enabled: false }))];
  const models = await request(t, records);
  assert.deepEqual(models.map(m => m.modelId), [...retained, ...additions.map(m => m.modelId)]);
  assert.equal(models.filter(m => m.enabled === false).length, 6);
});

test('disabled retained models remain hidden while GPT-6 drafts are visible', async t => {
  const models = await request(t, [...retained.map(modelId => ({ modelId, enabled: false })),
    ...additions.map(model => ({ ...model, enabled: false }))]);
  assert.deepEqual(models.map(model => model.modelId), additions.map(model => model.modelId));
});
