const { Schema, model } = require("mongoose");

const LimitsSchema = Schema(
  {
    maxImages: { type: Number, default: 0 }, // макс. число изображений
    maxImageSizeMb: { type: Number, default: 0 }, // макс. размер 1 изображения
    maxFiles: { type: Number, default: 0 }, // макс. число файлов
    maxFileSizeMb: { type: Number, default: 0 }, // макс. размер 1 файла
    maxLinks: { type: Number, default: 0 }, // макс. число ссылок
    maxTextChars: { type: Number, default: 0 }, // макс. длина текста
  },
  { _id: false },
);

const TooltipSchema = Schema(
  {
    title: { type: String, required: true }, // напр. "GPT-5.4"
    intro: { type: String, required: true }, // краткое описание
    pros: [{ type: String }], // список плюсов
    cons: [{ type: String }], // список минусов
  },
  { _id: false },
);

const ContentSchema = Schema(
  {
    desc: { type: String, required: true }, // "Most. Powerful."
    subDesc: { type: String, default: null }, // доп. описание или null
    tooltip: { type: TooltipSchema, required: true },
  },
  { _id: false },
);

const ChatModelsSchema = Schema(
  {
    modelId: { type: String }, // gpt-4o-mini
    label: { type: String },
    category: {
      type: String,
      enum: [
        "chat",
        "search",
        "image",
        "audio",
        "video",
        "document",
        "speech-to-text",
        "text-to-speech",
      ],
    },
    inputPerM: { type: Number },
    outputPerM: { type: Number },
    pricePerImage: { type: Number, default: 0 },
    pricePerMinute: { type: Number, default: 0 },
    pricePer1MChars: { type: Number, default: 0 },
    enabled: { type: Boolean },
    minRole: { type: String },
    //       {
    // id: "gpt-4o-mini",
    // label: "GPT-4o Mini",
    // category: "fast",
    // inputPerM: 0.15,
    // outputPerM: 0.60,
    // enabled: true,
    // default: true
    // }
    type: { type: String },
    groupId: { type: String },
    flow: { type: String },
    engine: { type: String },

    tokens: { type: Number },
    amount: { type: Number, default: null },
    unit: { type: String, default: null },
    default: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
    order: { type: Number },
    limits: {
      type: LimitsSchema,
      default: null, // или можешь поставить дефолты
    },
    content: {
      type: ContentSchema,
      default: null,
    },
  },
  { versionKey: false, timestamps: true },
);

const ChatModels = model("chatModels", ChatModelsSchema);

module.exports = ChatModels;
