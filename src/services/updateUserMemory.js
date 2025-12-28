const OpenAI = require("openai");
const { UserMemory, ChatMessage } = require("../models");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MEMORY_MESSAGES_LIMIT = 50;

const updateUserMemory = async (userId) => {
  const messages = await ChatMessage.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(MEMORY_MESSAGES_LIMIT)
    .lean();

  const conversation = messages
    .reverse()
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const prompt = `
Summarize the important long-term memory about the user.
Store only stable facts, preferences, skills.

Conversation:
${conversation}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: prompt }],
  });

  const summary = completion.choices[0].message.content;

  await UserMemory.findOneAndUpdate(
    { user: userId },
    { summary },
    { upsert: true, new: true }
  );
};

module.exports = updateUserMemory;
