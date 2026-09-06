const crypto = require("crypto");
const OpenAI = require("openai");
const mongoose = require("mongoose");
const {
  ChatTurn,
  ChatMessage,
  ChatConversation,
  User,
} = require("../../models");
const { estimateTokens } = require("../../utils");
const { finalizeChargeInTransaction } = require("../finalizeCharge");
const { errorFor } = require("./protocol");
const { messageDto } = require("./snapshot");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LEASE_MS = Number(process.env.CHAT_V2_LEASE_MS || 30_000);
const HEARTBEAT_MS = Math.max(1_000, Math.floor(LEASE_MS / 3));
const BATCH_MS = Number(process.env.CHAT_V2_BATCH_MS || 80);
const NEGATIVE_LIMIT = -1000;
let ioRef = null;

const setIo = (io) => { ioRef = io; };
const room = (userId) => userId.toString();
const emit = (userId, event, envelope) => ioRef?.to(room(userId)).emit(event, envelope);

const safeProviderError = (error) => {
  const status = error?.status;
  const code = status === 429 || status >= 500 ? "PROVIDER_UNAVAILABLE" : "INTERNAL_ERROR";
  return errorFor(code);
};

const buildContent = (text, files = []) => {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const file of files) {
    if (file?.mimetype?.startsWith("image/") && file.url) {
      content.push({ type: "image_url", image_url: { url: file.url } });
    }
  }
  return content;
};

const claimTurn = async (turnId) => {
  const leaseToken = crypto.randomUUID();
  const now = new Date();
  const turn = await ChatTurn.findOneAndUpdate(
    {
      turnId,
      status: "queued",
    },
    {
      $set: {
        status: "processing",
        processingStartedAt: now,
        leaseToken,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
    },
    { new: true },
  );
  return turn ? { turn, leaseToken } : null;
};

const claimNextQueued = async () => {
  const leaseToken = crypto.randomUUID();
  const now = new Date();
  const turn = await ChatTurn.findOneAndUpdate(
    { status: "queued" },
    {
      $set: {
        status: "processing",
        processingStartedAt: now,
        leaseToken,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
    },
    { new: true, sort: { createdAt: 1 } },
  );
  return turn ? { turn, leaseToken } : null;
};

const heartbeat = async (turn, leaseToken) => {
  const result = await ChatTurn.updateOne(
    {
      _id: turn._id,
      turnId: turn.turnId,
      attempt: turn.attempt,
      status: "processing",
      leaseToken,
      leaseUntil: { $gt: new Date() },
    },
    { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } },
  );
  return result.modifiedCount === 1;
};

const updatePartial = async (turn, leaseToken, partialContent, seq) => {
  const result = await ChatTurn.updateOne(
    {
      _id: turn._id,
      turnId: turn.turnId,
      attempt: turn.attempt,
      status: "processing",
      leaseToken,
      leaseUntil: { $gt: new Date() },
      lastSeq: seq - 1,
    },
    { $set: { partialContent, lastSeq: seq } },
  );
  return result.modifiedCount === 1;
};

const failTurn = async (turn, leaseToken, errorObject) => {
  const updated = await ChatTurn.findOneAndUpdate(
    {
      _id: turn._id,
      turnId: turn.turnId,
      attempt: turn.attempt,
      status: "processing",
      leaseToken,
    },
    {
      $set: {
        status: "failed",
        error: errorObject,
        leaseToken: null,
        leaseUntil: null,
      },
    },
    { new: true },
  );
  if (updated) {
    emit(turn.user, "chat:error", {
      protocolVersion: 2,
      event: "chat:error",
      type: "failed",
      turnId: turn.turnId,
      clientMessageId: turn.clientMessageId,
      conversationId: turn.conversation.toString(),
      attempt: turn.attempt,
      payload: { error: errorObject },
    });
  }
  return updated;
};

const commitCompletion = async (turn, leaseToken, assistantText, usage) => {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const current = await ChatTurn.findOne({
        _id: turn._id,
        turnId: turn.turnId,
        attempt: turn.attempt,
        status: "processing",
        leaseToken,
        leaseUntil: { $gt: new Date() },
      }).session(session);
      if (!current) throw Object.assign(new Error(), { staleLease: true });

      const cost = await finalizeChargeInTransaction({
        session,
        turnId: turn.turnId,
        userId: turn.user,
        modelId: turn.modelId,
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        },
      });

      let assistant = current.assistantMessage
        ? await ChatMessage.findById(current.assistantMessage).session(session)
        : null;

      if (!assistant) {
        [assistant] = await ChatMessage.create([{
          user: turn.user,
          conversation: turn.conversation,
          role: "assistant",
          content: assistantText,
          modelId: turn.modelId,
          tokens: usage.completionTokens,
          turnId: turn.turnId,
          attempt: turn.attempt,
          meta: { appTokens: cost.appTokens, costUsd: cost.usd },
        }], { session });
      }

      const billing = {
        appTokensSpent: cost.appTokens,
        totalTokens: usage.totalTokens,
        balance: cost.balance,
      };

      const completedAt = new Date();
      const completionUpdate = await ChatTurn.updateOne(
        {
          _id: current._id,
          turnId: turn.turnId,
          attempt: turn.attempt,
          status: "processing",
          leaseToken,
          leaseUntil: { $gt: completedAt },
        },
        {
          $set: {
            assistantMessage: assistant._id,
            usage,
            billing,
            billingAppliedAt: completedAt,
            status: "completed",
            completedAt,
            leaseToken: null,
            leaseUntil: null,
            partialContent: assistantText,
          },
        },
        { session },
      );

      if (completionUpdate.modifiedCount !== 1) {
        throw Object.assign(new Error("Stale worker lease"), { staleLease: true });
      }

      await ChatConversation.updateOne(
        { _id: turn.conversation, user: turn.user },
        { $set: { lastMessageAt: new Date() } },
        { session },
      );

      result = { assistant: assistant.toObject(), billing };
    });
  } finally {
    await session.endSession();
  }
  return result;
};

const processTurn = async (claimed) => {
  const { turn, leaseToken } = claimed;
  let heartbeatTimer;
  try {
    heartbeatTimer = setInterval(() => heartbeat(turn, leaseToken).catch(() => {}), HEARTBEAT_MS);

    const history = await ChatMessage.find({
      user: turn.user,
      conversation: turn.conversation,
      deleted: null,
    }).sort({ createdAt: -1 }).limit(20).lean();

    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      ...history.reverse().map((m) => ({
        role: m.role,
        content: m.role === "user" ? buildContent(m.content, m.attachments) : m.content,
      })),
    ];

    let assistantText = turn.partialContent || "";
    let seq = turn.lastSeq || 0;
    const stream = await client.chat.completions.create({
      model: turn.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let usage;
    let pending = "";
    let lastFlush = Date.now();


    let emittedSince = 0;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens || 0,
          completionTokens: chunk.usage.completion_tokens || 0,
          totalTokens: chunk.usage.total_tokens || 0,
        };
      }
      if (!delta) continue;
      pending += delta;
      emittedSince += delta.length;
      if (Date.now() - lastFlush >= BATCH_MS || emittedSince >= 256) {
        const chunkText = pending;
        assistantText += chunkText;
        pending = "";
        seq += 1;
        const ok = await updatePartial(turn, leaseToken, assistantText, seq);
        if (!ok) return;
        emit(turn.user, "chat:stream", {
          protocolVersion: 2,
          event: "chat:stream",
          type: "delta",
          turnId: turn.turnId,
          clientMessageId: turn.clientMessageId,
          conversationId: turn.conversation.toString(),
          attempt: turn.attempt,
          payload: { seq, chunk: chunkText },
        });
        emittedSince = 0;
        lastFlush = Date.now();
      }
    }

    if (pending) {
      const chunkText = pending;
      assistantText += chunkText;
      pending = "";
      seq += 1;
      const ok = await updatePartial(turn, leaseToken, assistantText, seq);
      if (!ok) return;
      emit(turn.user, "chat:stream", {
        protocolVersion: 2,
        event: "chat:stream",
        type: "delta",
        turnId: turn.turnId,
        clientMessageId: turn.clientMessageId,
        conversationId: turn.conversation.toString(),
        attempt: turn.attempt,
        payload: { seq, chunk: chunkText },
      });
    }

    if (!usage) {
      usage = {
        promptTokens: estimateTokens(JSON.stringify(messages)),
        completionTokens: estimateTokens(assistantText),
        totalTokens: estimateTokens(JSON.stringify(messages)) + estimateTokens(assistantText),
      };
    }

    const completion = await commitCompletion(turn, leaseToken, assistantText, usage);
    emit(turn.user, "chat:end", {
      protocolVersion: 2,
      event: "chat:end",
      type: "completed",
      turnId: turn.turnId,
      clientMessageId: turn.clientMessageId,
      conversationId: turn.conversation.toString(),
      attempt: turn.attempt,
      payload: {
        assistantMessage: messageDto(completion.assistant),
        billing: completion.billing,
      },
    });
  } catch (error) {
    if (error?.staleLease) return;
    const protocol = error?.code === "INSUFFICIENT_BALANCE"
      ? errorFor("INSUFFICIENT_BALANCE")
      : safeProviderError(error);
    await failTurn(turn, leaseToken, protocol);
  } finally {
    clearInterval(heartbeatTimer);
  }
};

const recoverExpired = async () => {
  const expired = await ChatTurn.find({
    status: "processing",
    leaseUntil: { $lte: new Date() },
  }).select("_id turnId user conversation clientMessageId attempt");
  for (const turn of expired) {
    const error = errorFor("PROCESS_INTERRUPTED");
    const updated = await ChatTurn.findOneAndUpdate(
      { _id: turn._id, status: "processing", leaseUntil: { $lte: new Date() } },
      { $set: { status: "failed", error, leaseToken: null, leaseUntil: null } },
      { new: true },
    );
    if (updated) {
      emit(turn.user, "chat:error", {
        protocolVersion: 2,
        event: "chat:error",
        type: "failed",
        turnId: turn.turnId,
        clientMessageId: turn.clientMessageId,
        conversationId: turn.conversation.toString(),
        attempt: turn.attempt,
        payload: { error },
      });
    }
  }
};

const startWorker = async () => {
  await recoverExpired();
  let active = 0;
  const maxWorkers = Number(process.env.CHAT_V2_WORKERS || 4);
  const tick = async () => {
    while (active < maxWorkers) {
      const claimed = await claimNextQueued();
      if (!claimed) break;
      active += 1;
      processTurn(claimed).finally(() => { active -= 1; });
    }
  };
  await tick();
  const timer = setInterval(async () => {
    try {
      await recoverExpired();
      await tick();
    } catch (error) {
      console.error("chat v2 worker error", error);
    }
  }, 2_000);
  return () => clearInterval(timer);
};

module.exports = {
  setIo,
  claimTurn,
  heartbeat,
  updatePartial,
  commitCompletion,
  processTurn,
  startWorker,
  recoverExpired,
};
