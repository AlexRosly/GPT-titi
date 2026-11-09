// Exact requested IDs. No runtime aliasing or fallback between models.
const additions = [
  { modelId: 'gpt-6-luna', label: 'GPT-6 Luna', apiMode: 'responses', reasoningEffort: 'none' },
  { modelId: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', apiMode: 'responses', reasoningEffort: 'low' },
  { modelId: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', apiMode: 'responses', reasoningEffort: 'medium' },
  { modelId: 'gpt-6-astra', label: 'GPT-6 Astra', apiMode: 'responses', reasoningEffort: 'medium' },
];
const retained = ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5'];
const allowedEfforts = Object.fromEntries(additions.map(model => [model.modelId,
  ['low', 'medium', 'high', 'xhigh', 'max', ...(['gpt-6-luna', 'gpt-6.1-terra'].includes(model.modelId) ? ['none'] : [])]]));
const retired = /^(?:o1(?:-\d{4}-\d{2}-\d{2})?|o3-mini(?:-\d{4}-\d{2}-\d{2})?|gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?|gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?)$/;

function plan(existing) {
  const relevant = existing.filter(m => additions.some(n => n.modelId === m.modelId) || retained.includes(m.modelId) || retired.test(m.modelId));
  const ids = relevant.map(m => m.modelId);
  if (new Set(ids).size !== ids.length) throw Error('Duplicate model IDs in catalog; resolve them before applying this migration.');
  const operations = [];
  for (const model of relevant.filter(m => retired.test(m.modelId))) {
    if (model.enabled !== false || model.default) operations.push({ updateOne: { filter: { modelId: model.modelId }, update: { $set: { enabled: false, default: false } } } });
  }
  for (const model of additions) {
    const found = existing.find(m => m.modelId === model.modelId);
    if (found && found.enabled) throw Error(`Model ${model.modelId} is already enabled; review its existing provider configuration first.`);
    operations.push({ updateOne: { filter: { modelId: model.modelId }, update: { $set: { ...model, enabled: false },
      $setOnInsert: { category: 'chat', engine: 'openai', default: false } }, upsert: true } });
  }
  return operations;
}
module.exports = { additions, retained, retired, allowedEfforts, plan };
