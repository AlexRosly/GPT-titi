const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// const cloudinary = require("../config/cloudinary");

const {
  User,
  ChatMessage,
  ChatConversation,
  ChatModels,
} = require("../models");

const { estimateTokens, estimateCost } = require("../utils");
const finalizeCharge = require("./finalizeCharge");

const NEGATIVE_LIMIT = -1000;
const HISTORY_LIMIT = 20;

const runChat = async ({
  userId,
  conversationId,
  modelId,
  message,
  onChunk,
  files = [],
}) => {
  /* 1️⃣ user */
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  /* 2️⃣ conversation */
  const conversation = await ChatConversation.findOne({
    _id: conversationId,
    user: userId,
    archived: false,
  });
  if (!conversation) throw new Error("Conversation not found");

  /* 3️⃣ model */
  const model = await ChatModels.findOne({ modelId, enabled: true }).lean();
  if (!model) throw new Error("Model not available");

  /* 4️⃣ save user message (ОДИН РАЗ!) */
  // await ChatMessage.create({
  //   user: userId,
  //   conversation: conversationId,
  //   role: "user",
  //   content: message,
  //   modelId,
  // });
  await ChatMessage.create({
    user: userId,
    conversation: conversationId,
    role: "user",
    content: message,
    modelId,
    attachments: files,
  });

  /* 5️⃣ history */
  const history = await ChatMessage.find({
    user: userId,
    conversation: conversationId,
    deleted: null,
  })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();

  const buildMessageContent = (message, files = []) => {
    const content = [];

    if (message) {
      content.push({
        type: "text",
        text: message,
      });
    }

    for (const file of files) {
      if (file.mimetype.startsWith("image/")) {
        content.push({
          type: "image_url",
          image_url: {
            // url: `${process.env.APP_URL}${file.url}`,
            url: file.url,
          },
        });
      }
    }

    return content;
  };
  // const buildMessageContent = (message, files = []) => {
  //   const content = [];

  //   // text
  //   if (message) {
  //     content.push({
  //       type: "text",
  //       text: message,
  //     });
  //   }

  //   for (const file of files) {
  //     // IMAGE
  //     if (file.mimetype.startsWith("image/")) {
  //       content.push({
  //         type: "image_url",
  //         image_url: {
  //           url: process.env.APP_URL + file.url,
  //         },
  //       });
  //     }

  //     // AUDIO
  //     if (file.mimetype.startsWith("audio/")) {
  //       content.push({
  //         type: "text",
  //         text: `[Audio file attached: ${file.originalName}]`,
  //       });
  //     }

  //     // PDF
  //     if (file.mimetype === "application/pdf") {
  //       content.push({
  //         type: "text",
  //         text: `[PDF attached: ${file.originalName}]`,
  //       });
  //     }
  //   }

  //   return content;
  // };
  // const messages = [
  //   {
  //     role: "system",
  //     content: `You are a helpful assistant.\n${conversation.summary || ""}`,
  //   },
  //   ...history.reverse().map((m) => ({
  //     role: m.role,
  //     content: m.content,
  //   })),
  // ];
  const messages = [
    {
      role: "system",
      content: "You are a helpful assistant.",
    },

    ...history.reverse().map((m) => ({
      role: m.role,

      content:
        m.role === "user"
          ? buildMessageContent(m.content, m.attachments)
          : m.content,
    })),
  ];

  /* 6️⃣ check balance */
  const estimatedTokens = estimateTokens(message);
  const estimate = await estimateCost(modelId, estimatedTokens);

  if (user.appTokens - estimate.appTokens < NEGATIVE_LIMIT) {
    throw new Error("Insufficient balance");
  }

  /* 7️⃣ stream */
  let assistantText = "";
  // let usage;

  const stream = await client.chat.completions.create({
    model: modelId,
    messages,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    // if (delta) {
    //   assistantText += delta;
    //   onChunk?.(delta); // 🔥 ключевая штука
    // }
    if (!delta) continue;
    assistantText += delta;

    onChunk?.(delta);

    // if (chunk.usage) usage = chunk.usage;
  }
  /* 8️⃣ save assistant */
  const promptTokens = estimateTokens(JSON.stringify(messages));

  const completionTokens = estimateTokens(assistantText);

  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };

  const assistantMsg = await ChatMessage.create({
    user: userId,
    conversation: conversationId,
    role: "assistant",
    content: assistantText,
    modelId,
    tokens: completionTokens,
    // tokens: usage?.completion_tokens || 0,
  });

  /* 9️⃣ списание токенов (АТОМАРНО) */
  // if (usage) {
  const cost = await finalizeCharge({
    userId,
    modelId,
    usage,
  });

  assistantMsg.meta = {
    appTokens: cost.appTokens,
    costUsd: cost.usd,
  };

  await assistantMsg.save();
  // }

  await ChatConversation.findByIdAndUpdate(conversationId, {
    lastMessageAt: new Date(),
  });

  // for (const file of files) {
  //   if (file.publicId) {
  //     await cloudinary.uploader.destroy(file.publicId, {
  //       resource_type: "image",
  //     });
  //   }
  // }

  // return assistantMsg;
  return {
    assistantMsg,

    // usage: {
    // promptTokens, //Сколько токенов ушло во входящий запрос модели.
    // completionTokens, //Сколько токенов модель сгенерировала в ответ.
    // totalTokens: usage.total_tokens, //Сумма promptTokens+completionTokens
    // },

    billing: {
      appTokensSpent: cost.appTokens, // потрачено токенов
      totalTokens: usage.total_tokens, //Сумма promptTokens+completionTokens

      // usdSpent: cost.usd,
      balance: cost.balance, //Текущий баланс пользователя после списания.
    },
  };
};

module.exports = runChat;
