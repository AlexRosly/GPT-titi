// controllers/chat/conversations/regenerateLastAnswer.js
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const {
  ChatMessage,
  ChatConversation,
  ChatModels,
  User,
} = require("../../../models");

const { estimateTokens, estimateCost } = require("../../../utils");
const { finalizeCharge } = require("../../../services");

const HISTORY_LIMIT = 20;
const NEGATIVE_LIMIT = -1000;

const regenerateLastAnswer = async (req, res) => {
  const { id: conversationId } = req.params;
  const userId = req.user.id;

  /* 1️⃣ Проверяем чат */
  const conversation = await ChatConversation.findOne({
    _id: conversationId,
    user: userId,
    archived: false,
  });

  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  /* 2️⃣ Последнее сообщение ассистента */
  const lastAssistant = await ChatMessage.findOne({
    conversation: conversationId,
    user: userId,
    role: "assistant",
    deleted: false,
  }).sort({ createdAt: -1 });

  if (!lastAssistant) {
    return res
      .status(400)
      .json({ error: "No assistant message to regenerate" });
  }

  /* 3️⃣ Последнее сообщение пользователя */
  const lastUserMessage = await ChatMessage.findOne({
    conversation: conversationId,
    user: userId,
    role: "user",
    deleted: false,
  }).sort({ createdAt: -1 });

  if (!lastUserMessage) {
    return res.status(400).json({ error: "No user message found" });
  }

  /* 4️⃣ Помечаем старый ответ ассистента как удалённый */
  lastAssistant.deleted = true;
  await lastAssistant.save();

  /* 5️⃣ Проверяем пользователя */
  const user = await User.findById(userId);

  /* 6️⃣ Проверяем модель */
  const model = await ChatModels.findOne({
    modelId: lastUserMessage.modelId,
    enabled: true,
  }).lean();

  if (!model) {
    return res.status(400).json({ error: "Model not available" });
  }

  /* 7️⃣ Загружаем short-term память */
  const history = await ChatMessage.find({
    conversation: conversationId,
    user: userId,
    deleted: false,
  })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();

  const messages = [
    { role: "system", content: "You are a helpful assistant" },
    ...history.reverse().map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  /* 8️⃣ Предоценка стоимости */
  const estimatedTokens = estimateTokens(lastUserMessage.content);
  const estimate = await estimateCost(model.modelId, estimatedTokens);

  const projectedBalance = user.appTokens - estimate.appTokens;

  if (projectedBalance < NEGATIVE_LIMIT) {
    return res.status(402).json({
      error: "Insufficient balance",
      balance: user.appTokens,
      estimatedCost: estimate.appTokens,
    });
  }

  /* 9️⃣ SSE */
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let assistantText = "";
  let usage;

  try {
    const stream = await client.chat.completions.create({
      model: model.modelId,
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
  } catch (err) {
    console.error("Regenerate stream error:", err);
    res.write("\n[ERROR]");
  } finally {
    if (assistantText) {
      const assistantMsg = await ChatMessage.create({
        user: userId,
        conversation: conversationId,
        role: "assistant",
        content: assistantText,
        modelId: model.modelId,
        tokens: usage?.completion_tokens || 0,
      });

      if (usage) {
        const cost = await finalizeCharge({
          userId,
          modelId: model.modelId,
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

module.exports = regenerateLastAnswer;
