require("dotenv").config();

const crypto = require("crypto");
const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { io: ioClient } = require("socket.io-client");

const TEST_MONGO_URI = process.env.CHAT_V2_TEST_MONGO_URI;

const TEST_DB_BASE = "gpt_titi_test";

const TEST_DB_NAME = `${TEST_DB_BASE}_ws_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;

const SOCKET_PORT = Number(process.env.CHAT_V2_TEST_SOCKET_PORT || 0);

if (!TEST_MONGO_URI) {
  test(
    "Chat Delivery v2 WebSocket integration requires CHAT_V2_TEST_MONGO_URI",
    {
      skip: "Set CHAT_V2_TEST_MONGO_URI to a MongoDB replica set/Atlas test cluster.",
    },
    () => {},
  );
} else {
  if (!/^gpt_titi_test/i.test(TEST_DB_NAME) || TEST_DB_NAME.length > 38) {
    throw new Error(
      `Unsafe Chat Delivery v2 WebSocket test database '${TEST_DB_NAME}'.`,
    );
  }

  const {
    User,
    ChatModels,
    ChatConversation,
    ChatTurn,
    ChatMessage,
  } = require("../../src/models");

  /*
   * We intentionally patch only the worker boundary in this suite.
   *
   * The real Socket.IO server, auth middleware, v2 handler and
   * acceptTurn() remain active.
   *
   * Provider/OpenAI execution is covered separately.
   */
  const worker = require("../../src/services/chatDeliveryV2/worker");

  const { initWsServer } = require("../../src/wsServer");

  const makeId = () => crypto.randomUUID();

  const createFixture = async () => {
    const suffix = makeId();

    const modelId = `chat-v2-ws-test-model-${suffix}`;

    const user = await User.create({
      email: `chat-v2-ws-${suffix}@example.test`,
      name: "Chat v2 websocket integration user",
      status: "active",
      appTokens: 10000,
    });

    await ChatModels.create({
      modelId,
      label: "Chat v2 websocket integration model",
      category: "chat",
      enabled: true,
      inputPerM: 0.15,
      outputPerM: 0.6,
    });

    const conversation = await ChatConversation.create({
      user: user._id,
      title: "Chat Delivery v2 WebSocket test",
      modelId,
      archived: false,
    });

    return {
      user,
      conversation,
      modelId,
    };
  };

  const signToken = (user) =>
    jwt.sign(
      {
        userId: user._id.toString(),
      },
      process.env.JWT_SECRET,
    );

  const makeEnvelope = ({
    conversationId,
    modelId,
    clientMessageId = makeId(),
    message = "hello",
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

  let server;

  const connectClient = async (token) => {
    const socket = ioClient(`http://127.0.0.1:${server.address().port}`, {
      auth: {
        token,
      },

      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Socket connection timeout")),
        5000,
      );

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
      const timer = setTimeout(
        () => reject(new Error(`${event} ACK timeout`)),
        5000,
      );

      socket.emit(event, payload, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

  const waitForEvent = (
    socket,
    event,
    predicate = () => true,
    timeoutMs = 5000,
  ) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, handler);

        reject(new Error(`Timed out waiting for ${event}`));
      }, timeoutMs);

      const handler = (payload) => {
        if (!predicate(payload)) {
          return;
        }

        clearTimeout(timer);

        socket.off(event, handler);

        resolve(payload);
      };

      socket.on(event, handler);
    });

  let originalStartWorker;
  let originalClaimTurn;
  let originalProcessTurn;
  let originalSetIo;

  test.before(async () => {
    await mongoose.connect(TEST_MONGO_URI, {
      dbName: TEST_DB_NAME,
    });

    await Promise.all([
      User.createIndexes(),
      ChatModels.createIndexes(),
      ChatConversation.createIndexes(),
      ChatTurn.createIndexes(),
      ChatMessage.createIndexes(),
    ]);

    /*
     * Prevent the production worker loop and
     * OpenAI provider from running.
     *
     * The handler itself remains real.
     */
    originalStartWorker = worker.startWorker;

    originalClaimTurn = worker.claimTurn;

    originalProcessTurn = worker.processTurn;

    originalSetIo = worker.setIo;

    /*
     * Capture the real Socket.IO instance
     * installed by initWsServer().
     */
    worker.setIo = (io) => {
      worker.__testIo = io;

      return originalSetIo(io);
    };

    worker.startWorker = async () => () => {};

    server = http.createServer();

    initWsServer(server);

    await new Promise((resolve, reject) => {
      server.once("error", reject);

      server.listen(SOCKET_PORT, "127.0.0.1", resolve);
    });
  });

  test.after(async () => {
    worker.startWorker = originalStartWorker;

    worker.claimTurn = originalClaimTurn;

    worker.processTurn = originalProcessTurn;

    worker.setIo = originalSetIo;

    delete worker.__testIo;

    /*
     * Stop accepting new HTTP/Socket.IO
     * connections before removing the DB.
     */
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));

      server = null;
    }

    /*
     * Each suite uses its own unique DB.
     * Remove it so Atlas does not accumulate
     * hundreds of test collections.
     */
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.db.dropDatabase();

      await mongoose.disconnect();
    }
  });

  test.beforeEach(() => {
    /*
     * Each accepted turn is actually claimed
     * by the handler's asynchronous setImmediate
     * path.
     *
     * The fake processTurn exercises transport
     * lifecycle without calling a provider.
     */

    worker.claimTurn = async (turnId) => {
      const leaseToken = `test-${turnId}`;

      const turn = await ChatTurn.findOneAndUpdate(
        {
          turnId,
          status: "queued",
        },

        {
          $set: {
            status: "processing",

            processingStartedAt: new Date(),

            leaseToken,

            leaseUntil: new Date(Date.now() + 30_000),
          },
        },

        {
          new: true,
        },
      );

      return turn
        ? {
            turn,
            leaseToken,
          }
        : null;
    };

    worker.processTurn = async ({ turn }) => {
      const conversationId = turn.conversation.toString();

      worker.__testIo?.to(turn.user.toString()).emit("chat:stream", {
        protocolVersion: 2,

        event: "chat:stream",

        type: "delta",

        turnId: turn.turnId,

        clientMessageId: turn.clientMessageId,

        conversationId,

        attempt: turn.attempt,

        payload: {
          seq: 1,
          chunk: "test response",
        },
      });

      /*
       * Persist completion BEFORE chat:end.
       *
       * This mirrors the protocol invariant:
       * DB is authoritative before terminal
       * transport notification.
       */
      await ChatTurn.updateOne(
        {
          _id: turn._id,
          status: "processing",
        },

        {
          $set: {
            status: "completed",

            lastSeq: 1,

            partialContent: "test response",

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

        payload: {
          assistantMessage: null,

          billing: null,
        },
      });
    };
  });

  test("real Socket.IO chat:send returns v2 ACK and persists the turn", async () => {
    const { user, conversation, modelId } = await createFixture();

    const socket = await connectClient(signToken(user));

    try {
      const envelope = makeEnvelope({
        conversationId: conversation._id,

        modelId,
      });

      const ack = await emitWithAck(socket, "chat:send", envelope);

      assert.equal(ack.ok, true);

      assert.equal(ack.protocolVersion, 2);

      assert.equal(ack.disposition, "accepted");

      /*
       * ACK is durable acceptance, not
       * completion.
       */
      assert.equal(ack.turn.status, "queued");

      assert.equal(ack.turn.clientMessageId, envelope.payload.clientMessageId);

      assert.equal(ack.turn.conversationId, conversation._id.toString());

      const persisted = await ChatTurn.findOne({
        user: user._id,

        clientMessageId: envelope.payload.clientMessageId,
      }).lean();

      assert.ok(persisted);

      assert.equal(persisted.turnId, ack.turn.turnId);
    } finally {
      socket.disconnect();
    }
  });

  test("real Socket.IO duplicate chat:send is idempotent", async () => {
    const { user, conversation, modelId } = await createFixture();

    const socket = await connectClient(signToken(user));

    try {
      const envelope = makeEnvelope({
        conversationId: conversation._id,

        modelId,
      });

      const first = await emitWithAck(socket, "chat:send", envelope);

      const second = await emitWithAck(socket, "chat:send", envelope);

      assert.equal(first.ok, true);

      assert.equal(first.disposition, "accepted");

      assert.equal(second.ok, true);

      assert.equal(second.disposition, "duplicate");

      assert.equal(second.turn.turnId, first.turn.turnId);

      assert.equal(
        await ChatTurn.countDocuments({
          user: user._id,

          clientMessageId: envelope.payload.clientMessageId,
        }),
        1,
      );

      assert.equal(
        await ChatMessage.countDocuments({
          user: user._id,

          clientMessageId: envelope.payload.clientMessageId,
        }),
        1,
      );
    } finally {
      socket.disconnect();
    }
  });

  test("real Socket.IO conflicting retry of clientMessageId returns IDEMPOTENCY_CONFLICT", async () => {
    const { user, conversation, modelId } = await createFixture();

    const socket = await connectClient(signToken(user));

    try {
      const envelope = makeEnvelope({
        conversationId: conversation._id,

        modelId,

        message: "original",
      });

      const first = await emitWithAck(socket, "chat:send", envelope);

      assert.equal(first.ok, true);

      const conflicting = {
        ...envelope,

        payload: {
          ...envelope.payload,

          message: "changed",
        },
      };

      const second = await emitWithAck(socket, "chat:send", conflicting);

      assert.equal(second.ok, false);

      assert.equal(second.protocolVersion, 2);

      assert.equal(second.error.code, "IDEMPOTENCY_CONFLICT");

      assert.equal(
        await ChatTurn.countDocuments({
          user: user._id,

          clientMessageId: envelope.payload.clientMessageId,
        }),
        1,
      );
    } finally {
      socket.disconnect();
    }
  });

  test("real Socket.IO status is owner-scoped and returns the accepted turn", async () => {
    const { user, conversation, modelId } = await createFixture();

    const socket = await connectClient(signToken(user));

    try {
      const send = await emitWithAck(
        socket,
        "chat:send",

        makeEnvelope({
          conversationId: conversation._id,

          modelId,
        }),
      );

      const status = await emitWithAck(
        socket,
        "chat:status",

        {
          protocolVersion: 2,
          event: "chat:status",
          type: "request",

          payload: {
            turnId: send.turn.turnId,
          },
        },
      );

      assert.equal(status.ok, true);

      assert.equal(status.protocolVersion, 2);

      assert.equal(status.turn.turnId, send.turn.turnId);
    } finally {
      socket.disconnect();
    }
  });

  test("real Socket.IO foreign user cannot access another user's turn status", async () => {
    const owner = await createFixture();

    const attacker = await createFixture();

    const ownerSocket = await connectClient(signToken(owner.user));

    const attackerSocket = await connectClient(signToken(attacker.user));

    try {
      const send = await emitWithAck(
        ownerSocket,
        "chat:send",

        makeEnvelope({
          conversationId: owner.conversation._id,

          modelId: owner.modelId,
        }),
      );

      const status = await emitWithAck(
        attackerSocket,
        "chat:status",

        {
          protocolVersion: 2,
          event: "chat:status",
          type: "request",

          payload: {
            turnId: send.turn.turnId,
          },
        },
      );

      assert.equal(status.ok, false);

      assert.equal(status.error.code, "TURN_NOT_FOUND");
    } finally {
      ownerSocket.disconnect();
      attackerSocket.disconnect();
    }
  });

  test("real Socket.IO invalid envelope returns a protocol error ACK", async () => {
    const { user } = await createFixture();

    const socket = await connectClient(signToken(user));

    try {
      const response = await emitWithAck(
        socket,
        "chat:send",

        {
          protocolVersion: 2,
          event: "chat:send",
          type: "request",

          payload: {
            clientMessageId: "not-a-uuid",

            conversationId: "not-an-object-id",

            modelId: "missing",

            message: "hello",

            files: [],
          },
        },
      );

      assert.equal(response.ok, false);

      assert.equal(response.protocolVersion, 2);

      assert.equal(typeof response.error.code, "string");
    } finally {
      socket.disconnect();
    }
  });

  test("real Socket.IO emits chat:stream and chat:end for an accepted turn", async () => {
    const { user, conversation, modelId } = await createFixture();

    const socket = await connectClient(signToken(user));

    const events = [];

    const onStream = (payload) => {
      events.push(["stream", payload]);
    };

    const onEnd = (payload) => {
      events.push(["end", payload]);
    };

    socket.on("chat:stream", onStream);

    socket.on("chat:end", onEnd);

    try {
      /*
       * Generate the envelope FIRST.
       *
       * clientMessageId is therefore known
       * before chat:send, so we can subscribe
       * to the exact terminal event before the
       * worker has any possibility of emitting it.
       */
      const envelope = makeEnvelope({
        conversationId: conversation._id,

        modelId,
      });

      /*
       * IMPORTANT:
       *
       * Subscribe BEFORE chat:send.
       *
       * We match by clientMessageId because
       * turnId does not exist on the client
       * until the durable ACK is received.
       */
      const endPromise = waitForEvent(
        socket,
        "chat:end",

        (payload) =>
          payload?.protocolVersion === 2 &&
          payload?.event === "chat:end" &&
          payload?.type === "completed" &&
          payload?.clientMessageId === envelope.payload.clientMessageId,

        10_000,
      );

      const send = await emitWithAck(socket, "chat:send", envelope);

      assert.equal(send.ok, true);

      assert.equal(send.protocolVersion, 2);

      assert.equal(send.disposition, "accepted");

      assert.equal(send.turn.clientMessageId, envelope.payload.clientMessageId);

      /*
       * No setTimeout(100).
       *
       * Wait for the actual terminal event
       * corresponding to THIS logical request.
       */
      const endEvent = await endPromise;

      assert.equal(endEvent.turnId, send.turn.turnId);

      assert.equal(endEvent.clientMessageId, send.turn.clientMessageId);

      assert.equal(endEvent.conversationId, conversation._id.toString());

      assert.equal(endEvent.attempt, 1);

      /*
       * chat:end is emitted only after
       * persisted completion in our worker
       * boundary.
       */
      const persisted = await ChatTurn.findOne({
        turnId: send.turn.turnId,
      }).lean();

      assert.ok(persisted);

      assert.equal(persisted.status, "completed");

      assert.equal(persisted.lastSeq, 1);

      assert.equal(persisted.partialContent, "test response");

      assert.ok(
        events.some(
          ([type, payload]) =>
            type === "stream" &&
            payload?.turnId === send.turn.turnId &&
            payload?.payload?.seq === 1,
        ),
      );

      assert.ok(
        events.some(
          ([type, payload]) =>
            type === "end" &&
            payload?.turnId === send.turn.turnId &&
            payload?.type === "completed",
        ),
      );
    } finally {
      socket.off("chat:stream", onStream);

      socket.off("chat:end", onEnd);

      socket.disconnect();
    }
  });
}
