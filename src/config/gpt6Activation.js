const { responsesModels, allowedEfforts } = require('./modelCatalog202611');

// Standard short-context USD / 1M tokens, verified 2026-11-24 at
// https://developers.openai.com/api/docs/pricing . Only missing DB prices use
// these initial values; existing prices and the billing formulas are preserved.
const initialPrices = {
  'gpt-6-luna': { inputPerM: 0.1, outputPerM: 0.5 },
  'gpt-6.1-terra': { inputPerM: 1, outputPerM: 5 },
  'gpt-6.1-sol': { inputPerM: 2, outputPerM: 10 },
  'gpt-6-astra': { inputPerM: 10, outputPerM: 50 },
  'gpt-6.2-astra': { inputPerM: 8, outputPerM: 40 },
  'gpt-6.2-sol': { inputPerM: 2, outputPerM: 10 },
};
const models = responsesModels.filter(model => Object.hasOwn(initialPrices, model.modelId));

function plan(existing) {
  const target = existing.filter(row => models.some(model => model.modelId === row.modelId));
  if (new Set(target.map(model => model.modelId)).size !== target.length) throw Error('Duplicate GPT-6 model IDs. Resolve them before activation.');
  return models.map(model => {
    const row = target.find(current => current.modelId === model.modelId);
    const values = { enabled: true, apiMode: 'responses', reasoningEffort: row?.reasoningEffort || model.reasoningEffort };
    if (!allowedEfforts[model.modelId].includes(values.reasoningEffort)) throw Error(`Unsupported reasoning effort for ${model.modelId}.`);
    for (const field of ['inputPerM', 'outputPerM']) {
      const price = row?.[field];
      if (price === null || price === undefined) values[field] = initialPrices[model.modelId][field];
      else if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) throw Error(`Invalid ${field} for ${model.modelId}.`);
    }
    return { updateOne: { filter: { modelId: model.modelId }, update: { $set: values,
      $setOnInsert: { label: model.label, category: 'chat', engine: 'openai', type: 'model', minRole: 'user', default: false } }, upsert: true } };
  });
}

module.exports = { models, initialPrices, plan };
