// const { Schema, model } = require("mongoose");

// const TokenUsageSchema = Schema(
//   {
//     user: {
//       type: Schema.Types.ObjectId,
//       ref: "user",
//       required: true,
//       index: true,
//     },

//     model: { type: String }, // gpt-4o-mini, gpt-5.1 etc
//     promptTokens: { type: Number },
//     completionTokens: { type: Number },
//     totalTokens: { type: Number },

//     costUsd: { type: Number }, // реальная стоимость OpenAI
//     appTokensSpent: { type: Number }, // сколько списали с юзера
//   },
//   { versionKey: false, timestamps: true }
// );

// const TokenUsage = model("tokenUsege", TokenUsageSchema);

// module.exports = TokenUsage;
