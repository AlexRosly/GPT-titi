const additions = [
  { modelId: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', apiMode: 'responses', reasoningEffort: 'medium' },
  { modelId: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', apiMode: 'responses', reasoningEffort: 'medium' },
];

// Insert-only rollout: existing model settings, prices and activation are never
// rewritten. An unexpectedly enabled target requires review before any writes.
function plan(existing) {
  const ids = new Set(additions.map(model => model.modelId));
  const targets = existing.filter(model => ids.has(model.modelId));
  if (new Set(targets.map(model => model.modelId)).size !== targets.length) throw Error('Duplicate GPT-6.2 model IDs; resolve before adding drafts.');
  if (targets.some(model => model.enabled !== false)) throw Error('An existing GPT-6.2 record is not explicitly disabled; review it before adding drafts.');
  return additions.filter(model => !targets.some(row => row.modelId === model.modelId)).map(model => ({
    updateOne: { filter: { modelId: model.modelId }, update: { $setOnInsert: { ...model,
      enabled: false, default: false, category: 'chat', engine: 'openai', type: 'model', minRole: 'user' } }, upsert: true },
  }));
}

module.exports = { additions, plan };
