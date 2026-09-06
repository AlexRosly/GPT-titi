require("dotenv").config();

const crypto = require("crypto");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { io: ioClient } = require("socket.io-client");

const TEST_MONGO_URI = process.env.CHAT_V2_TEST_MONGO_URI;
const TEST_DB_NAME = `gpt_titi_test_dod_${process.pid}_${crypto.randomUUID().slice(0, 6)}`;
const SOCKET_PORT = Number(process.env.CHAT_V2_TEST_SOCKET_PORT || 0);

if (!TEST_MONGO_URI) {
  test(
    "Chat Delivery v2 DoD integration requires CHAT_V2_TEST_MONGO_URI",
    { skip: "Set CHAT_V2_TEST_MONGO_URI to a MongoDB replica set/Atlas test cluster." },
    () => {},
  );
} else {
  const {
    User,
    ChatModels,
    ChatConversation,
    ChatTurn,
    ChatMessage,
    ChatBillingLedger,
  } = require("../../src/models");
  const worker = require("../../src/services/chatDeliveryV2/worker");
  const { initWsServer } = require("../../src/wsServer");

  const makeId = () => crypto.randomUUID();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitUntil = async (predicate, timeoutMs = 5000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await predicate();
      if (value) return value;
      await sleep(25);
    }
    throw new Error("Timed out waiting for condition");
  };

  const createFixture = async ({ appTokens = 10000 } = {}) => {
    const suffix = makeId();
    const modelId = `chat-v2-dod-model-${suffix}`;
    const user = await User.create({
      email: `chat-v2-dod-${suffix}@example.test`,
      name: "Chat v2 DoD user",
      status: "active",
      appTokens,
    });
    await ChatModels.create({
      modelId,
      label: "Chat v2 DoD model",
      category: "chat",
      enabled: true,
      inputPerM: 0.15,
      outputPerM: 0.6,
    });
    const conversation = await ChatConversation.create({
      user: user._id,
      title: "Chat Delivery v2 DoD",
      modelId,
      archived: false,
      lastMessageAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    return { user, conversation, modelId };
  };

  const signToken = (user) =>
    jwt.sign({ userId: user._id.toString() }, process.env.JWT_SECRET);

  const makeEnvelope = ({
    conversationId,
    modelId,
    clientMessageId = makeId(),
    message = "delivery-v2-dod",
  }) => ({
    protocolVersion: 2,
    event: "chat:send",
    type: "request",
    payload: {
      clientMessageId,
      conversationId: conversationId.toString(),
      modelId,
      message,
      files: [],
    },
  });

  const makeTurnEnvelope = (event, turnId) => ({
    protocolVersion: 2,
    event,
    type: "request",
    payload: { turnId },
  });

  const connectClient = async (token) => {
    const socket = ioClient(`http://127.0.0.1:${server.address().port}`, {
      auth: { token },
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Socket connection timeout")), 5000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("connect_error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return socket;
  };

  const emitWithAck = (socket, event, payload) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} ACK timeout`)), 5000);
      socket.emit(event, payload, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

  const waitForEvent = (socket, event, predicate = () => true, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, handler);
        reject(new Error(`Timed out waiting for ${event}`));
      }, timeoutMs);
      const handler = (payload) => {
        if (!predicate(payload)) return;
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      };
      socket.on(event, handler);
    });

  let server;
  let originalStartWorker;
  let originalClaimTurn;
  let originalProcessTurn;
  let originalSetIo;
  let legacyCalls = 0;

  test.before(async () => {
    await mongoose.connect(TEST_MONGO_URI, { dbName: TEST_DB_NAME });
    await Promise.all([
      User.createIndexes(),
      ChatModels.createIndexes(),
      ChatConversation.createIndexes(),
      ChatTurn.createIndexes(),
      ChatMessage.createIndexes(),
      ChatBillingLedger.createIndexes(),
    ]);

    originalStartWorker = worker.startWorker;
    originalClaimTurn = worker.claimTurn;
    originalProcessTurn = worker.processTurn;
    originalSetIo = worker.setIo;

    worker.startWorker = async () => () => {};
    worker.setIo = (io) => {
      worker.__dodIo = io;
      return originalSetIo(io);
    };

    server = http.createServer();
    initWsServer(server, {
      runChat: async ({ onChunk }) => {
        legacyCalls += 1;
        onChunk?.("legacy response");
        return { billing: { appTokens: 1, balance: 9999 } };
      },
    });

    await new Promise((resolve, reject) => {
      server.listen(SOCKET_PORT, "127.0.0.1", resolve);
      server.once("error", reject);
    });
  });

  test.after(async () => {
    worker.startWorker = originalStartWorker;
    worker.claimTurn = originalClaimTurn;
    worker.processTurn = originalProcessTurn;
    worker.setIo = originalSetIo;
    delete worker.__dodIo;

    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });

  test.beforeEach(() => {
    worker.claimTurn = originalClaimTurn;
    worker.processTurn = originalProcessTurn;
  });

  test("20 concurrent duplicate sends create one turn, one user message, one provider execution and one debit", async () => {
    const { user, conversation, modelId } = await createFixture();
    const socket = await connectClient(signToken(user));
    const envelope = makeEnvelope({ conversationId: conversation._id, modelId });
    const before = await User.findById(user._id).lean();
    let providerCalls = 0;

    worker.processTurn = async ({ turn, leaseToken }) => {
      providerCalls += 1;
      await worker.commitCompletion(turn, leaseToken, "exactly once", {
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 125,
      });
    };

    try {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => emitWithAck(socket, "chat:send", envelope)),
      );
      const accepted = responses.filter((response) => response.ok && response.disposition === "accepted");
      const duplicates = responses.filter((response) => response.ok && response.disposition === "duplicate");

      assert.equal(accepted.length, 1);
      assert.equal(duplicates.length, 19);
      assert.equal(new Set(responses.map((response) => response.turn.turnId)).size, 1);

      const turnId = accepted[0].turn.turnId;
      await waitUntil(async () => (await ChatTurn.findOne({ turnId }).lean())?.status === "completed");

      assert.equal(providerCalls, 1);
      assert.equal(await ChatTurn.countDocuments({ user: user._id, clientMessageId: envelope.payload.clientMessageId }), 1);
      assert.equal(await ChatMessage.countDocuments({ turnId, role: "user" }), 1);
      assert.equal(await ChatMessage.countDocuments({ turnId, role: "assistant" }), 1);
      assert.equal(await ChatBillingLedger.countDocuments({ turnId }), 1);

      const ledger = await ChatBillingLedger.findOne({ turnId }).lean();
      const after = await User.findById(user._id).lean();
      assert.equal(before.appTokens - after.appTokens, ledger.appTokensSpent);
    } finally {
      socket.disconnect();
    }
  });

  test("lost ACK resend finds the already accepted turn and creates no second user message", async () => {
    const { user, conversation, modelId } = await createFixture();
    const socket = await connectClient(signToken(user));
    const envelope = makeEnvelope({ conversationId: conversation._id, modelId });
    worker.claimTurn = async () => null;

    try {
      socket.emit("chat:send", envelope); // simulate the client never receiving/using the ACK
      const persisted = await waitUntil(() =>
        ChatTurn.findOne({ user: user._id, clientMessageId: envelope.payload.clientMessageId }).lean(),
      );

      const resend = await emitWithAck(socket, "chat:send", envelope);
      assert.equal(resend.ok, true);
      assert.equal(resend.disposition, "duplicate");
      assert.equal(resend.turn.turnId, persisted.turnId);
      assert.equal(await ChatMessage.countDocuments({ turnId: persisted.turnId, role: "user" }), 1);
    } finally {
      socket.disconnect();
    }
  });

  test("accepted queued turn survives the ACK-before-provider crash window and can be claimed after restart", async () => {
    const { user, conversation, modelId } = await createFixture();
    const socket = await connectClient(signToken(user));
    worker.claimTurn = async () => null;

    try {
      const ack = await emitWithAck(socket, "chat:send", makeEnvelope({ conversationId: conversation._id, modelId }));
      assert.equal(ack.ok, true);
      assert.equal(ack.turn.status, "queued");

      const queued = await ChatTurn.findOne({ turnId: ack.turn.turnId }).lean();
      assert.equal(queued.status, "queued");
      assert.equal(await ChatBillingLedger.countDocuments({ turnId: ack.turn.turnId }), 0);

      const claimed = await originalClaimTurn(ack.turn.turnId);
      assert.ok(claimed);
      assert.equal(claimed.turn.status, "processing");
    } finally {
      socket.disconnect();
    }
  });

  test("duplicate send never starts provider for queued, processing, completed or failed snapshots", async () => {
    const statuses = ["queued", "processing", "completed", "failed"];
    let providerCalls = 0;
    worker.claimTurn = async () => null;
    worker.processTurn = async () => { providerCalls += 1; };

    for (const status of statuses) {
      const { user, conversation, modelId } = await createFixture();
      const socket = await connectClient(signToken(user));
      const envelope = makeEnvelope({ conversationId: conversation._id, modelId });
      try {
        const first = await emitWithAck(socket, "chat:send", envelope);
        assert.equal(first.disposition, "accepted");
        await ChatTurn.updateOne(
          { turnId: first.turn.turnId },
          {
            $set: {
              status,
              error: status === "failed" ? { code: "PROVIDER_UNAVAILABLE", message: "AI service is temporarily unavailable.", retryable: true } : null,
              completedAt: status === "completed" ? new Date() : null,
              leaseToken: status === "processing" ? "duplicate-state-lease" : null,
              leaseUntil: status === "processing" ? new Date(Date.now() + 30_000) : null,
            },
          },
        );
        const duplicate = await emitWithAck(socket, "chat:send", envelope);
        assert.equal(duplicate.ok, true);
        assert.equal(duplicate.disposition, "duplicate");
        assert.equal(duplicate.turn.status, status);
      } finally {
        socket.disconnect();
      }
    }
    await sleep(50);
    assert.equal(providerCalls, 0);
  });

  test("stream sequence persistence is strict and cannot skip or replay seq", async () => {
    const { user, conversation, modelId } = await createFixture();
    const socket = await connectClient(signToken(user));
    worker.claimTurn = async () => null;
    try {
      const ack = await emitWithAck(socket, "chat:send", makeEnvelope({ conversationId: conversation._id, modelId }));
      const claimed = await originalClaimTurn(ack.turn.turnId);
      assert.ok(claimed);

      assert.equal(await worker.updatePartial(claimed.turn, claimed.leaseToken, "A", 1), true);
      assert.equal(await worker.updatePartial(claimed.turn, claimed.leaseToken, "ABC", 3), false);
      assert.equal(await worker.updatePartial(claimed.turn, claimed.leaseToken, "A replay", 1), false);
      assert.equal(await worker.updatePartial(claimed.turn, claimed.leaseToken, "AB", 2), true);

      const persisted = await ChatTurn.findOne({ turnId: ack.turn.turnId }).lean();
      assert.equal(persisted.lastSeq, 2);
      assert.equal(persisted.partialContent, "AB");
    } finally {
      socket.disconnect();
    }
  });

  test("lifecycle events are delivered only to the authenticated user's room", async () => {
    const owner = await createFixture();
    const other = await createFixture();
    const ownerSocket = await connectClient(signToken(owner.user));
    const otherSocket = await connectClient(signToken(other.user));
    const otherEvents = [];
    otherSocket.on("chat:stream", (payload) => otherEvents.push(payload));
    otherSocket.on("chat:end", (payload) => otherEvents.push(payload));

    worker.processTurn = async ({ turn }) => {
      const envelopeBase = {
        protocolVersion: 2,
        turnId: turn.turnId,
        clientMessageId: turn.clientMessageId,
        conversationId: turn.conversation.toString(),
        attempt: turn.attempt,
      };
      worker.__dodIo.to(turn.user.toString()).emit("chat:stream", {
        ...envelopeBase,
        event: "chat:stream",
        type: "delta",
        payload: { seq: 1, chunk: "room only" },
      });
      worker.__dodIo.to(turn.user.toString()).emit("chat:end", {
        ...envelopeBase,
        event: "chat:end",
        type: "completed",
        payload: { assistantMessage: null, billing: null },
      });
    };

    try {
      const endPromise = waitForEvent(ownerSocket, "chat:end");
      const ack = await emitWithAck(
        ownerSocket,
        "chat:send",
        makeEnvelope({ conversationId: owner.conversation._id, modelId: owner.modelId }),
      );
      const end = await endPromise;
      assert.equal(end.turnId, ack.turn.turnId);
      await sleep(200);
      assert.equal(otherEvents.filter((event) => event.turnId === ack.turn.turnId).length, 0);
    } finally {
      ownerSocket.disconnect();
      otherSocket.disconnect();
    }
  });

  test("crash after completion commit but before chat:end is recoverable by status with no second debit", async () => {
    const { user, conversation, modelId } = await createFixture();
    const token = signToken(user);
    let socket = await connectClient(token);
    worker.claimTurn = async () => null;

    const ack = await emitWithAck(socket, "chat:send", makeEnvelope({ conversationId: conversation._id, modelId }));
    const claimed = await originalClaimTurn(ack.turn.turnId);
    const before = await User.findById(user._id).lean();
    const completion = await worker.commitCompletion(claimed.turn, claimed.leaseToken, "committed before crash", {
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: 100,
    });
    assert.equal(completion.assistant.content, "committed before crash");

    const committed = await ChatTurn.findOne({ turnId: ack.turn.turnId }).lean();
    const balanceAfterCommit = (await User.findById(user._id).lean()).appTokens;
    const ledger = await ChatBillingLedger.findOne({ turnId: ack.turn.turnId }).lean();
    assert.equal(before.appTokens - balanceAfterCommit, ledger.appTokensSpent);

    socket.disconnect(); // process/socket vanished before chat:end could be observed
    socket = await connectClient(token);
    try {
      const status = await emitWithAck(socket, "chat:status", makeTurnEnvelope("chat:status", ack.turn.turnId));
      assert.equal(status.ok, true);
      assert.equal(status.turn.status, "completed");
      assert.equal(status.turn.assistantMessage.content, "committed before crash");
      assert.deepEqual(status.turn.billing, committed.billing);
      assert.equal(await ChatMessage.countDocuments({ turnId: ack.turn.turnId, role: "assistant" }), 1);
      assert.equal(await ChatBillingLedger.countDocuments({ turnId: ack.turn.turnId }), 1);
      assert.equal((await User.findById(user._id).lean()).appTokens, balanceAfterCommit);
    } finally {
      socket.disconnect();
    }
  });

  test("duplicate and status replay do not mutate conversation activity or completedAt", async () => {
    const { user, conversation, modelId } = await createFixture();
    const socket = await connectClient(signToken(user));
    worker.claimTurn = async () => null;
    try {
      const envelope = makeEnvelope({ conversationId: conversation._id, modelId });
      const ack = await emitWithAck(socket, "chat:send", envelope);
      const claimed = await originalClaimTurn(ack.turn.turnId);
      await worker.commitCompletion(claimed.turn, claimed.leaseToken, "stable", {
        promptTokens: 30,
        completionTokens: 10,
        totalTokens: 40,
      });

      const turnBefore = await ChatTurn.findOne({ turnId: ack.turn.turnId }).lean();
      const conversationBefore = await ChatConversation.findById(conversation._id).lean();

      const duplicate = await emitWithAck(socket, "chat:send", envelope);
      const status = await emitWithAck(socket, "chat:status", makeTurnEnvelope("chat:status", ack.turn.turnId));
      assert.equal(duplicate.disposition, "duplicate");
      assert.equal(status.turn.status, "completed");

      const turnAfter = await ChatTurn.findOne({ turnId: ack.turn.turnId }).lean();
      const conversationAfter = await ChatConversation.findById(conversation._id).lean();
      assert.equal(turnAfter.completedAt.getTime(), turnBefore.completedAt.getTime());
      assert.equal(conversationAfter.lastMessageAt.getTime(), conversationBefore.lastMessageAt.getTime());
    } finally {
      socket.disconnect();
    }
  });

  test("v2 does not emit legacy chat_error and legacy v1 send still reaches the compatibility path", async () => {
    const { user, conversation, modelId } = await createFixture();
    const socket = await connectClient(signToken(user));
    const underscoreEvents = [];
    socket.on("chat_error", (payload) => underscoreEvents.push(payload));

    try {
      const invalidV2 = makeEnvelope({ conversationId: conversation._id, modelId: `missing-${makeId()}` });
      const v2Ack = await emitWithAck(socket, "chat:send", invalidV2);
      assert.equal(v2Ack.ok, false);
      assert.equal(v2Ack.error.code, "MODEL_NOT_AVAILABLE");
      await sleep(100);
      assert.equal(underscoreEvents.length, 0);

      const beforeLegacyCalls = legacyCalls;
      const streamPromise = waitForEvent(socket, "chat:stream", (payload) => payload?.chunk === "legacy response");
      const endPromise = waitForEvent(socket, "chat:end", (payload) => payload?.type === "response");
      socket.emit("chat:send", {
        event: "chat:send",
        type: "request",
        payload: {
          conversationId: conversation._id.toString(),
          modelId,
          message: "legacy request",
          files: [],
        },
      });
      const [legacyStream, legacyEnd] = await Promise.all([streamPromise, endPromise]);
      assert.equal(legacyStream.chunk, "legacy response");
      assert.equal(legacyEnd.type, "response");
      assert.equal(legacyCalls, beforeLegacyCalls + 1);
    } finally {
      socket.disconnect();
    }
  });
}
