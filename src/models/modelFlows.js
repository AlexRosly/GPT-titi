const { Schema, model } = require("mongoose");

const ButtonSchema = Schema(
  {
    label: { type: String, required: true }, // "Analyze deeply"
    desc: { type: String, required: true }, // "Complex tasks, decisions, strategy."
    template: { type: String, required: true }, // промпт-шаблон
    icon: { type: String, required: true }, // "analyze-deeply"
  },
  { _id: false },
);

const ModelFlowsSchema = Schema(
  {
    type: { type: String, required: true }, // "gpt-5.5"
    modelId: { type: String, required: true }, // "gpt-5.5"
    header: { type: String, required: true }, // "What advanced task do you want to solve?"
    subtitle: { type: String, required: true }, // "Best for reasoning..."
    buttons: { type: [ButtonSchema], default: [] }, // массив кнопок
    examples: { type: [String], default: [] }, // массив строк-примеров
    archived: { type: Boolean, default: false },
  },
  {
    timestamps: true, // createdAt, updatedAt
    versionKey: false,
  },
);

// module.exports = mongoose.model("ModelConfig", ModelConfigSchema);
const ModelFlows = model("modelsFlow", ModelFlowsSchema);

module.exports = ModelFlows;
