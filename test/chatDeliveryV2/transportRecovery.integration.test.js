require("dotenv").config();

const crypto = require("crypto");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { io: ioClient } = require("socket.io-client");

const TEST_MONGO_URI = process.env.CHAT_V2_TEST_MONGO_URI;
const TEST_DB_NAME = `gpt_titi_test_tr_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
const SOCKET_PORT = Number(process.env.CHAT_V2_TEST_SOCKET_PORT || 0);

if (!TEST_MONGO_URI) {
  test(
    "Chat Delivery v2 transport recovery integration requires CHAT_V2_TEST_MONGO_URI",
    { skip: "Set CHAT_V2_TEST_MONGO_URI to a MongoDB replica set/Atlas test cluster." },
    () => {},
  );
} else {
  if (!/^gpt_titi_test/i.test(TEST_DB_NAME) || TEST_DB_NAME.length > 38) {
    throw new Error(`Unsafe Chat Delivery v2 transport-recovery test database '${TEST_DB_NAME}'.`);
  }

  const {
    User,
    ChatModels,
    ChatConversation,
    ChatTurn,
    ChatMessage,
  } = require("../../src/models");
  const worker = require("../../src/services/chatDeliveryV2/worker");
  const { initWsServer } = require("../../src/wsServer");
  const { errorFor } = require("../../src/services/chatDeliveryV2/protocol");

  const makeId = () => crypto.randomUUID();

  const createFixture = async () => {
    const suffix = makeId();
    const modelId = `chat-v2-transport-test-model-${suffix}`;

    const user = await User.create({
      email: `chat-v2-transport-${suffix}@example.test`,
      name: "Chat v2 transport recovery user",
      status: "active",
      appTokens: 10000,
    });

    await ChatModels.create({
      modelId,
      label: "Chat v2 transport recovery model",
      category: "chat",
      enabled: true,
      inputPerM: 0.15,
      outputPerM: 0.6,
    });

    const conversation = await ChatConversation.create({
      user: user._id,
      title: "Chat Delivery v2 transport recovery test",
      modelId,
      archived: false,
    });

    return { user, conversation, modelId };
  };

  const signToken = (user) =>
    jwt.sign({ userId: user._id.toString() }, process.env.JWT_SECRET);

  const makeSendEnvelope = ({
    conversationId,
    modelId,
    clientMessageId = makeId(),
    message = "transport recovery test",
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

  const emitWithAck = (socket, event, envelope) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} ACK timeout`)), 5000);
      socket.emit(event, envelope, (response) => {
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

  const installDeterministicWorker = () => {
    worker.claimTurn = async (turnId) => {
      const leaseToken = `test-${turnId}`;
      const turn = await ChatTurn.findOneAndUpdate(
        { turnId, status: "queued" },
        {
          $set: {
            status: "processing",
            processingStartedAt: new Date(),
            leaseToken,
            leaseUntil: new Date(Date.now() + 30_000),
          },
        },
        { new: true },
      );
      return turn ? { turn, leaseToken } : null;
    };

    worker.processTurn = async ({ turn }) => {
      const conversationId = turn.conversation.toString();

      await ChatTurn.updateOne(
        { _id: turn._id, status: "processing", attempt: turn.attempt },
        {
          $set: {
            lastSeq: 1,
            partialContent: "retry response",
          },
        },
      );

      worker.__testIo?.to(turn.user.toString()).emit("chat:stream", {
        protocolVersion: 2,
        event: "chat:stream",
        type: "delta",
        turnId: turn.turnId,
        clientMessageId: turn.clientMessageId,
        conversationId,
        attempt: turn.attempt,
        payload: { seq: 1, chunk: "retry response" },
      });

      await ChatTurn.updateOne(
        { _id: turn._id, status: "processing", attempt: turn.attempt },
        {
          $set: {
            status: "completed",
            completedAt: new Date(),
            leaseToken: null,
            leaseUntil: null,
          },
        },
      );

      worker.__testIo?.to(turn.user.toString()).emit("chat:end", {
        protocolVersion: 2,
        event: "chat:end",
        type: "completed",
        turnId: turn.turnId,
        clientMessageId: turn.clientMessageId,
        conversationId,
        attempt: turn.attempt,
        payload: { assistantMessage: null, billing: null },
      });
    };
  };

  const acceptWithoutStartingWorker = async ({ socket, conversation, modelId }) => {
    const deterministicClaim = worker.claimTurn;
    const deterministicProcess = worker.processTurn;
    worker.claimTurn = async () => null;

    try {
      const send = await emitWithAck(
        socket,
        "chat:send",
        makeSendEnvelope({ conversationId: conversation._id, modelId }),
      );
      assert.equal(send.ok, true);
      assert.equal(send.turn.status, "queued");
      await new Promise((resolve) => setImmediate(resolve));
      return send;
    } finally {
      worker.claimTurn = deterministicClaim;
      worker.processTurn = deterministicProcess;
    }
  };

  const markRetryableFailed = async (turnId) => {
    await ChatTurn.updateOne(
      { turnId },
      {
        $set: {
          status: "failed",
          error: errorFor("PROCESS_INTERRUPTED"),
          leaseToken: null,
          leaseUntil: null,
        },
      },
    );
  };

  test.before(async () => {
    await mongoose.connect(TEST_MONGO_URI, { dbName: TEST_DB_NAME });

    await Promise.all([
      User.createIndexes(),
      ChatModels.createIndexes(),
      ChatConversation.createIndexes(),
      ChatTurn.createIndexes(),
      ChatMessage.createIndexes(),
    ]);

    originalStartWorker = worker.startWorker;
    originalClaimTurn = worker.claimTurn;
    originalProcessTurn = worker.processTurn;
    originalSetIo = worker.setIo;

    worker.setIo = (io) => {
      worker.__testIo = io;
      return originalSetIo(io);
    };
    worker.startWorker = async () => () => {};

    server = http.createServer();
    initWsServer(server);

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
    delete worker.__testIo;

    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
      server = null;
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  test.beforeEach(() => {
    installDeterministicWorker();
  });

  test("real Socket.IO chat:retry advances one retryable failed turn without duplicating the user message", async () => {
    const { user, conversation, modelId } = await createFixture();
    const socket = await connectClient(signToken(user));

    try {
      const send = await acceptWithoutStartingWorker({ socket, conversation, modelId });
      await markRetryableFailed(send.turn.turnId);

      const streamPromise = waitForEvent(
        socket,
        "chat:stream",
        (payload) => payload.turnId === send.turn.turnId && payload.attempt === 2,
      );
      const endPromise = waitForEvent(
        socket,
        "chat:end",
        (payload) => payload.turnId === send.turn.turnId && payload.attempt === 2,
      );

      const retry = await emitWithAck(
        socket,
        "chat:retry",
        makeTurnEnvelope("chat:retry", send.turn.turnId),
      );

      assert.equal(retry.ok, true);
      assert.equal(retry.protocolVersion, 2);
      assert.equal(retry.turn.turnId, send.turn.turnId);
      assert.equal(retry.turn.status, "queued");
      assert.equal(retry.turn.attempt, 2);
      assert.equal(retry.turn.lastSeq, 0);
      assert.equal(retry.turn.partialContent, "");
      assert.equal(retry.turn.error, null);

      const [stream, end] = await Promise.all([streamPromise, endPromise]);
      assert.equal(stream.attempt, 2);
      assert.equal(stream.payload.seq, 1);
      assert.equal(end.attempt, 2);
      assert.equal(end.type, "completed");

      assert.equal(
        await ChatMessage.countDocuments({ turnId: send.turn.turnId, role: "user" }),
        1,
      );

      const persisted = await ChatTurn.findOne({ turnId: send.turn.turnId }).lean();
      assert.equal(persisted.attempt, 2);
      assert.equal(persisted.status, "completed");
    } finally {
      socket.disconnect();
    }
  });

  test("concurrent real Socket.IO chat:retry requests increment attempt only once", async () => {
    const { user, conversation, modelId } = await createFixture();
    const socketA = await connectClient(signToken(user));
    const socketB = await connectClient(signToken(user));

    try {
      const send = await acceptWithoutStartingWorker({ socket: socketA, conversation, modelId });
      await markRetryableFailed(send.turn.turnId);

      // Keep the successful retry queued so the assertion is about retry atomicity only.
      worker.claimTurn = async () => null;

      const envelope = makeTurnEnvelope("chat:retry", send.turn.turnId);
      const responses = await Promise.all([
        emitWithAck(socketA, "chat:retry", envelope),
        emitWithAck(socketB, "chat:retry", envelope),
      ]);

      const successes = responses.filter((response) => response.ok === true);
      const failures = responses.filter((response) => response.ok === false);

      assert.equal(successes.length, 1);
      assert.equal(successes[0].turn.attempt, 2);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].error.code, "TURN_NOT_RETRYABLE");

      const persisted = await ChatTurn.findOne({ turnId: send.turn.turnId }).lean();
      assert.equal(persisted.status, "queued");
      assert.equal(persisted.attempt, 2);
      assert.equal(
        await ChatMessage.countDocuments({ turnId: send.turn.turnId, role: "user" }),
        1,
      );
    } finally {
      socketA.disconnect();
      socketB.disconnect();
    }
  });

  test("foreign user cannot retry another user's turn", async () => {
    const owner = await createFixture();
    const attacker = await createFixture();
    const ownerSocket = await connectClient(signToken(owner.user));
    const attackerSocket = await connectClient(signToken(attacker.user));

    try {
      const send = await acceptWithoutStartingWorker({
        socket: ownerSocket,
        conversation: owner.conversation,
        modelId: owner.modelId,
      });
      await markRetryableFailed(send.turn.turnId);

      const response = await emitWithAck(
        attackerSocket,
        "chat:retry",
        makeTurnEnvelope("chat:retry", send.turn.turnId),
      );

      assert.equal(response.ok, false);
      assert.equal(response.protocolVersion, 2);
      assert.equal(response.error.code, "TURN_NOT_FOUND");

      const persisted = await ChatTurn.findOne({ turnId: send.turn.turnId }).lean();
      assert.equal(persisted.status, "failed");
      assert.equal(persisted.attempt, 1);
    } finally {
      ownerSocket.disconnect();
      attackerSocket.disconnect();
    }
  });

  test("completed turn returns TURN_NOT_RETRYABLE over real Socket.IO", async () => {
    const { user, conversation, modelId } = await createFixture();
    const socket = await connectClient(signToken(user));

    try {
      const send = await acceptWithoutStartingWorker({ socket, conversation, modelId });
      await ChatTurn.updateOne(
        { turnId: send.turn.turnId },
        { $set: { status: "completed", completedAt: new Date() } },
      );

      const response = await emitWithAck(
        socket,
        "chat:retry",
        makeTurnEnvelope("chat:retry", send.turn.turnId),
      );

      assert.equal(response.ok, false);
      assert.equal(response.error.code, "TURN_NOT_RETRYABLE");

      const persisted = await ChatTurn.findOne({ turnId: send.turn.turnId }).lean();
      assert.equal(persisted.status, "completed");
      assert.equal(persisted.attempt, 1);
    } finally {
      socket.disconnect();
    }
  });

  test("after reconnect chat:status returns durable processing partialContent and lastSeq", async () => {
    const { user, conversation, modelId } = await createFixture();
    const token = signToken(user);
    let socket = await connectClient(token);

    const send = await acceptWithoutStartingWorker({ socket, conversation, modelId });

    await ChatTurn.updateOne(
      { turnId: send.turn.turnId },
      {
        $set: {
          status: "processing",
          attempt: 1,
          partialContent: "durable partial",
          lastSeq: 3,
          processingStartedAt: new Date(),
          leaseToken: "reconnect-lease",
          leaseUntil: new Date(Date.now() + 30_000),
        },
      },
    );

    socket.disconnect();
    socket = await connectClient(token);

    try {
      const status = await emitWithAck(
        socket,
        "chat:status",
        makeTurnEnvelope("chat:status", send.turn.turnId),
      );

      assert.equal(status.ok, true);
      assert.equal(status.turn.status, "processing");
      assert.equal(status.turn.attempt, 1);
      assert.equal(status.turn.lastSeq, 3);
      assert.equal(status.turn.partialContent, "durable partial");
      assert.equal(status.turn.assistantMessage, null);
      assert.equal(status.turn.billing, null);
    } finally {
      socket.disconnect();
    }
  });

  test("after reconnect chat:status returns authoritative completed assistant and billing without side effects", async () => {
    const { user, conversation, modelId } = await createFixture();
    const token = signToken(user);
    let socket = await connectClient(token);

    const send = await acceptWithoutStartingWorker({ socket, conversation, modelId });

    const assistant = await ChatMessage.create({
      user: user._id,
      conversation: conversation._id,
      role: "assistant",
      content: "authoritative completed response",
      modelId,
      tokens: 42,
      turnId: send.turn.turnId,
      attempt: 1,
    });

    const billing = {
      appTokensSpent: 12,
      totalTokens: 42,
      balance: 9988,
    };

    await ChatTurn.updateOne(
      { turnId: send.turn.turnId },
      {
        $set: {
          status: "completed",
          assistantMessage: assistant._id,
          partialContent: assistant.content,
          lastSeq: 4,
          billing,
          billingAppliedAt: new Date(),
          completedAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
        },
      },
    );

    const beforeMessages = await ChatMessage.countDocuments({ turnId: send.turn.turnId });
    const beforeUser = await User.findById(user._id).lean();

    socket.disconnect();
    socket = await connectClient(token);

    try {
      const status = await emitWithAck(
        socket,
        "chat:status",
        makeTurnEnvelope("chat:status", send.turn.turnId),
      );

      assert.equal(status.ok, true);
      assert.equal(status.turn.status, "completed");
      assert.equal(status.turn.lastSeq, 4);
      assert.equal(status.turn.partialContent, "authoritative completed response");
      assert.equal(status.turn.assistantMessage.id, assistant._id.toString());
      assert.equal(status.turn.assistantMessage.role, "assistant");
      assert.equal(status.turn.assistantMessage.content, "authoritative completed response");
      assert.equal(status.turn.assistantMessage.turnId, send.turn.turnId);
      assert.deepEqual(status.turn.billing, billing);

      assert.equal(
        await ChatMessage.countDocuments({ turnId: send.turn.turnId }),
        beforeMessages,
      );
      const afterUser = await User.findById(user._id).lean();
      assert.equal(afterUser.appTokens, beforeUser.appTokens);
    } finally {
      socket.disconnect();
    }
  });
}
