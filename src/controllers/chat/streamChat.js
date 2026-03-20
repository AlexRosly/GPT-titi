// //2️⃣ Контроллер streamChat (ядро)
// const { User, ChatMessage, ChatModels } = require("../../models");
// const OpenAI = require("openai");
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// const { estimateTokens } = require("../../utils");
// const {
//   chargeUserPreview,
//   finalizeCharge,
//   previewLedger,
// } = require("../../services");

// const streamChat = async (req, res) => {
//   const { message, model = "gpt-4o-mini" } = req.body;
//   const user = req.user;

//   // SSE headers
//   res.setHeader("Content-Type", "text/event-stream");
//   res.setHeader("Cache-Control", "no-cache");
//   res.setHeader("Connection", "keep-alive");

//   let streamedText = "";
//   let estimatedTokens = 0;

//   const stream = await openai.chat.completions.create({
//     model,
//     messages: [{ role: "user", content: message }],
//     stream: true,
//   });

//   try {
//     for await (const chunk of stream) {
//       const delta = chunk.choices?.[0]?.delta?.content;
//       if (!delta) continue;

//       streamedText += delta;

//       // 🔢 приблизительная оценка
//       estimatedTokens += estimateTokens(delta);

//       // 💸 предварительное списание
//       const allowed = await chargeUserPreview(user._id, model, estimatedTokens);

//       if (!allowed) {
//         res.write(`event: error\ndata: Insufficient balance\n\n`);
//         break;
//       }

//       // 📤 отправляем кусок фронту
//       res.write(`data: ${JSON.stringify({ delta })}\n\n`);
//     }

//     res.write(`event: done\ndata: [DONE]\n\n`);
//     res.end();
//   } catch (err) {
//     console.error(err);
//     res.write(`event: error\ndata: Stream error\n\n`);
//     res.end();
//   } finally {
//     previewLedger.clear(user._id, model);
//     // 🔒 финальное списание по usage
//     if (stream.response?.usage) {
//       await finalizeCharge(user._id, model, stream.response.usage);
//     }
//   }
// };

// module.exports = streamChat;
//2️⃣ Контроллер streamChat (ядро)
// const { User, ChatMessage, ChatModels } = require("../../models");
// const OpenAI = require("openai");
// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// const { estimateTokens } = require("../../utils");
// const {
//   chargeUserPreview,
//   finalizeCharge,
//   previewLedger,
// } = require("../../services");

// // const { estimateCost } = require("../../utils");

// const HISTORY_LIMIT = 20;
// const NEGATIVE_LIMIT = -1000;

// const streamChat = async (req, res) => {
//   const { modelId, message } = req.body;
//   const userId = req.user.id;

//   if (!modelId || !message) {
//     return res.status(400).json({ error: "modelId and message required" });
//   }
//   /* ───────────── 0️⃣ Проверки ───────────── */

//   const model = await ChatModels.findOne({ modelId, enabled: true });
//   if (!model) {
//     return res.status(400).json({ error: "Model not available" });
//   }

//   const user = await User.findById(userId);
//   if (!user) {
//     return res.status(401).json({ error: "User not found" });
//   }

//   /* 1️⃣ Сохраняем сообщение пользователя */
//   const userTokens = estimateTokens(message);

//   await ChatMessage.create({
//     user: user._id,
//     role: "user",
//     content: message,
//     modelId,
//     tokens: userTokens,
//   });

//   /* 2️⃣ Загружаем short-term память */
//   const history = await ChatMessage.find({ user: user._id })
//     .sort({ createdAt: -1 })
//     .limit(HISTORY_LIMIT)
//     .lean();

//   const messages = [
//     { role: "system", content: "You are a helpful assistant" },
//     ...history.reverse().map((m) => ({
//       role: m.role,
//       content: m.content,
//     })),
//   ];

//   // /* 3️⃣ Оценка стоимости (приблизительно) */
//   // const estimatedTokens = estimateTokens(message);
//   // const estimatedAppTokens = estimateCost(model, estimatedTokens);

//   // const projectedBalance = user.appTokens - estimatedAppTokens;
//   // if (projectedBalance < NEGATIVE_LIMIT) {
//   //   return res.status(402).json({
//   //     error: "Insufficient balance",
//   //     balance: user.appTokens,
//   //     required: estimatedAppTokens,
//   //   });
//   // }

//   /* 4️⃣ Готовим стрим */
//   /* ───────────── 5️⃣ SSE заголовки ───────────── */
//   res.setHeader("Content-Type", "text/event-stream");
//   res.setHeader("Cache-Control", "no-cache");
//   res.setHeader("Connection", "keep-alive");

//   let assistantText = "";
//   let streamedTokens = 0;
//   let finalCost = null;

//   try {
//     const stream = await client.chat.completions.create({
//       model: modelId,
//       messages,
//       stream: true,
//     });

//     for await (const chunk of stream) {
//       const delta = chunk.choices[0]?.delta?.content;
//       if (delta) {
//         assistantText += delta;
//         res.write(delta);
//       }
//     }
//   } catch (e) {
//     console.error("OpenAI stream error:", e);
//     res.write("\n[ERROR]");
//   } finally {
//     /* 5️⃣ Сохраняем ответ ассистента */
//     if (assistantText) {
//       await ChatMessage.create({
//         user: user._id,
//         role: "assistant",
//         content: assistantText,
//         modelId,
//       });
//     }

//     res.end();
//   }
// };

// module.exports = streamChat;

// const { User, ChatModels, ChatMessage } = require("../../models");

// const OpenAI = require("openai");
// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// const { estimateTokens, estimateCost } = require("../../utils");
// const {
//   chargeUserPreview,
//   finalizeCharge,
//   updateUserMemory,
// } = require("../../services");
// const previewLedger = require("../../services/previewLedger");

// const HISTORY_LIMIT = 20;
// const NEGATIVE_LIMIT = -1000;

// const streamChat = async (req, res) => {
//   const { modelId, message } = req.body;
//   const userId = req.user.id;

//   if (!modelId || !message) {
//     return res.status(400).json({
//       error: "modelId and message required",
//     });
//   }

//   /* ───────────── 0️⃣ Проверки ───────────── */

//   const model = await ChatModels.findOne({
//     modelId,
//     enabled: true,
//   }).lean();

//   if (!model) {
//     return res.status(400).json({
//       error: "Model not available",
//     });
//   }

//   const user = await User.findById(userId);
//   if (!user) {
//     return res.status(401).json({
//       error: "User not found",
//     });
//   }

//   /* ───────────── 3.1️⃣ Сохраняем сообщение пользователя ───────────── */

//   const userTokens = estimateTokens(message);

//   await ChatMessage.create({
//     user: user._id,
//     role: "user",
//     content: message,
//     modelId,
//     tokens: userTokens,
//   });

//   /* ───────────── 4️⃣ Загружаем short-term память ───────────── */

//   const history = await ChatMessage.find({
//     user: user._id,
//   })
//     .sort({ createdAt: -1 })
//     .limit(HISTORY_LIMIT)
//     .lean();

//   const messages = [
//     { role: "system", content: "You are a helpful assistant" },
//     ...history.reverse().map((m) => ({
//       role: m.role,
//       content: m.content,
//     })),
//   ];

//   /* 3️⃣ Оценка стоимости (приблизительно) */
//   const estimatedTokens = estimateTokens(message);

//   // estimateCost → возвращает { appTokens, usd, ... }
//   const estimate = await estimateCost(modelId, estimatedTokens);

//   const projectedBalance = user.appTokens - estimate.appTokens;

//   // ✅ ИСПРАВЛЕНИЕ: используем NEGATIVE_LIMIT
//   if (projectedBalance < NEGATIVE_LIMIT) {
//     return res.status(402).json({
//       error: "Insufficient balance",
//       balance: user.appTokens,
//       estimatedCost: estimate.appTokens,
//       limit: NEGATIVE_LIMIT,
//     });
//   }

//   /* ───────────── 5️⃣ SSE заголовки ───────────── */

//   res.setHeader("Content-Type", "text/event-stream");
//   res.setHeader("Cache-Control", "no-cache");
//   res.setHeader("Connection", "keep-alive");

//   let assistantText = "";
//   let streamedTokens = 0;
//   let finalCost = null;

//   try {
//     const stream = await client.chat.completions.create({
//       model: modelId,
//       messages,
//       stream: true,
//     });

//     /* ───────────── 3.2️⃣ Стрим + preview-списание ───────────── */

//     for await (const chunk of stream) {
//       const delta = chunk.choices?.[0]?.delta?.content;
//       if (!delta) continue;

//       assistantText += delta;

//       streamedTokens += estimateTokens(delta);

//       const allowed = await chargeUserPreview(
//         user._id,
//         modelId,
//         streamedTokens
//       );

//       if (!allowed) {
//         res.write(`event: error\ndata: Insufficient balance\n\n`);
//         break;
//       }

//       res.write(`data: ${JSON.stringify({ delta })}\n\n`);
//     }

//     res.write(`event: done\ndata: [DONE]\n\n`);
//   } catch (err) {
//     console.error("OpenAI stream error:", err);
//     res.write(`event: error\ndata: Stream error\n\n`);
//   } finally {
//     /* ───────────── 3.3️⃣ Финальное списание ───────────── */

//     try {
//       if (assistantText) {
//         finalCost = await finalizeCharge(user._id, modelId, {
//           prompt_tokens: userTokens,
//           completion_tokens: streamedTokens,
//         });
//       }
//     } catch (e) {
//       console.error("Finalize charge error:", e);
//     }

//     /* ───────────── 3.4️⃣ Сохраняем ответ ассистента ───────────── */

//     if (assistantText) {
//       await ChatMessage.create({
//         user: user._id,
//         role: "assistant",
//         content: assistantText,
//         modelId,
//         tokens: streamedTokens,
//         meta: finalCost
//           ? {
//               appTokens: finalCost.appTokens,
//               costUsd: finalCost.usd,
//             }
//           : undefined,
//       });
//     }

//     if (assistantText) {
//       await ChatMessage.create({
//         user: user._id,
//         role: "assistant",
//         content: assistantText,
//         modelId,
//       });

//       // 🔁 обновляем память НЕ блокируя пользователя
//       updateUserMemory(user._id).catch(console.error);
//     }

//     previewLedger.clear(user._id, modelId);

//     res.end();
//   }
// };

// module.exports = streamChat;

const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const {
  User,
  ChatMessage,
  ChatConversation,
  ChatModels,
} = require("../../models");

const { estimateTokens, estimateCost } = require("../../utils");
const { finalizeCharge } = require("../../services");

const NEGATIVE_LIMIT = -1000;
const HISTORY_LIMIT = 20;

const streamChat = async (req, res) => {
  const { conversationId, modelId, message } = req.body;
  const userId = req.user.id;

  if (!conversationId || !modelId || !message) {
    return res.status(400).json({
      error: "conversationId, modelId and message are required",
    });
  }

  /* 1️⃣ Проверяем пользователя */
  const user = await User.findById(userId);
  if (!user) {
    return res.status(401).json({ error: "User not found" });
  }

  /* 2️⃣ Проверяем чат */
  const conversation = await ChatConversation.findOne({
    _id: conversationId,
    user: userId,
    archived: false,
  });

  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  /* 3️⃣ Проверяем модель */
  const model = await ChatModels.findOne({
    modelId,
    enabled: true,
  }).lean();

  if (!model) {
    return res.status(400).json({ error: "Model not available" });
  }

  /* 4️⃣ Сохраняем сообщение пользователя */
  await ChatMessage.create({
    user: userId,
    conversation: conversationId,
    role: "user",
    content: message,
    modelId,
  });

  /* 5️⃣ Загружаем short-term память (последние 20 сообщений чата) */
  const history = await ChatMessage.find({
    user: userId,
    conversation: conversationId,
    deletedAt: null,
  })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();

  // const messages = [
  //   { role: "system", content: "You are a helpful assistant" },
  //   ...history.reverse().map((m) => ({
  //     role: m.role,
  //     content: m.content,
  //   })),
  // ];

  const messages = [
    {
      role: "system",
      content: `
You are a helpful assistant.

Conversation summary:
${conversation.summary || "No summary yet"}
`,
    },
    ...history.reverse().map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  /* 6️⃣ Предварительная оценка стоимости */
  const estimatedTokens = estimateTokens(message);
  const estimate = await estimateCost(modelId, estimatedTokens);

  const projectedBalance = user.appTokens - estimate.appTokens;

  if (projectedBalance < NEGATIVE_LIMIT) {
    return res.status(402).json({
      error: "Insufficient balance",
      balance: user.appTokens,
      estimatedCost: estimate.appTokens,
      limit: NEGATIVE_LIMIT,
    });
  }

  /* 7️⃣ Подготавливаем SSE */
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let usage;
  let assistantText = "";

  try {
    const stream = await client.chat.completions.create({
      model: modelId,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        assistantText += delta;
        res.write(delta);
      }

      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    res.write(`event: done\ndata: [DONE]\n\n`);
    // res.end();
  } catch (err) {
    console.error("OpenAI stream error:", err);
    res.write(`event: error\ndata: Stream error\n\n`);
    // res.end();
  } finally {
    if (assistantText) {
      const assistantMsg = await ChatMessage.create({
        user: user._id,
        conversation: conversationId,
        role: "assistant",
        content: assistantText,
        modelId,
        tokens: usage?.completion_tokens || 0,
      });

      if (usage) {
        const cost = await finalizeCharge({
          userId: user._id,
          modelId,
          usage,
        });

        assistantMsg.meta = {
          appTokens: cost.appTokens,
          costUsd: cost.usd,
        };

        await assistantMsg.save();
      }

      await ChatConversation.findByIdAndUpdate(conversationId, {
        lastMessageAt: new Date(),
      });
    }

    res.end();
  }
};

module.exports = streamChat;
