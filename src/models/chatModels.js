const { Schema, model } = require("mongoose");

const ChatModelsSchema = Schema(
  {
    modelId: { type: String }, // gpt-4o-mini
    label: { type: String },
    // category: { type: String, enum: ["family", "mini", "realtime"] },

    inputPerM: { type: Number },
    outputPerM: { type: Number },
    enabled: { type: Boolean },
    minRole: { type: String },
    //         {
    //     id: "gpt-4o-mini",
    //     label: "GPT-4o Mini",
    //     category: "fast",
    //     inputPerM: 0.15,
    //     outputPerM: 0.60,
    //     enabled: true,
    //     default: true
    //   }
  },
  { versionKey: false, timestamps: true }
);

const ChatModels = model("chatModels", ChatModelsSchema);

module.exports = ChatModels;
