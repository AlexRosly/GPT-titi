require("dotenv").config();

const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const TEST_MONGO_URI = process.env.CHAT_V2_TEST_MONGO_URI;

// MongoDB Atlas ограничивает имя БД 38 байтами.
// Поэтому не используем CHAT_V2_TEST_DB как основу,
// если она потенциально длинная.
const TEST_DB_BASE = "gpt_titi_test";

const TEST_DB_NAME = `${TEST_DB_BASE}_w_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;

if (!TEST_MONGO_URI) {
  test(
    "Chat Delivery v2 worker integration requires CHAT_V2_TEST_MONGO_URI",
    {
      skip: "Set CHAT_V2_TEST_MONGO_URI to a MongoDB replica set/Atlas test cluster.",
    },
    () => {},
  );
} else {
  if (TEST_DB_NAME.length > 38) {
    throw new Error(
      `Chat Delivery v2 worker test database name is too long: ` +
        `'${TEST_DB_NAME}' (${TEST_DB_NAME.length} bytes).`,
    );
  }

  if (!/^gpt_titi_test/i.test(TEST_DB_NAME)) {
    throw new Error(
      `Refusing to run Chat Delivery v2 worker tests against database ` +
        `'${TEST_DB_NAME}'.`,
    );
  }

  const {
    User,
    ChatModels,
    ChatConversation,
    ChatTurn,
    ChatMessage,
  } = require("../../src/models");

  const worker = require("../../src/services/chatDeliveryV2/worker");
  const acceptTurn = require("../../src/services/chatDeliveryV2/acceptTurn");

  // дальше оставляем твой существующий код БЕЗ изменений

  const makeId = () => crypto.randomUUID();

  const createFixture = async () => {
    const suffix = makeId();
    const modelId = `chat-v2-worker-test-model-${suffix}`;

    const user = await User.create({
      email: `chat-v2-worker-${suffix}@example.test`,
      name: "Chat v2 worker integration user",
      status: "active",
      appTokens: 10000,
    });

    await ChatModels.create({
      modelId,
      label: "Chat v2 worker integration model",
      category: "chat",
      enabled: true,
      inputPerM: 0.15,
      outputPerM: 0.6,
    });

    const conversation = await ChatConversation.create({
      user: user._id,
      title: "Chat Delivery v2 worker test",
      modelId,
      archived: false,
    });

    return { user, conversation, modelId };
  };

  const createQueuedTurn = async () => {
    const { user, conversation, modelId } = await createFixture();
    const payload = {
      clientMessageId: makeId(),
      conversationId: conversation._id.toString(),
      modelId,
      message: "worker lifecycle test",
      files: [],
    };

    const result = await acceptTurn({ userId: user._id, payload });
    assert.equal(result.disposition, "accepted");
    return { user, conversation, modelId, turn: result.turn };
  };

  const makeIoSpy = () => {
    const events = [];
    return {
      events,
      io: {
        to(userId) {
          return {
            emit(event, payload) {
              events.push({ userId: userId.toString(), event, payload });
            },
          };
        },
      },
    };
  };

  // test.before(async () => {
  //   await mongoose.connect(TEST_MONGO_URI, { dbName: TEST_DB_NAME });
  //   await mongoose.connection.db.dropDatabase();

  //   await Promise.all([
  //     User.createIndexes(),
  //     ChatModels.createIndexes(),
  //     ChatConversation.createIndexes(),
  //     ChatTurn.createIndexes(),
  //     ChatMessage.createIndexes(),
  //   ]);
  // });

  test.before(async () => {
    await mongoose.connect(TEST_MONGO_URI, { dbName: TEST_DB_NAME });

    await Promise.all([
      User.createIndexes(),
      ChatModels.createIndexes(),
      ChatConversation.createIndexes(),
      ChatTurn.createIndexes(),
      ChatMessage.createIndexes(),
    ]);
  });

  // test.after(async () => {
  //   worker.setIo(null);

  //   if (mongoose.connection.readyState !== 0) {
  //     await mongoose.connection.db.dropDatabase();
  //     await mongoose.disconnect();
  //   }
  // });

  test.after(async () => {
    worker.setIo(null);

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  test("recoverExpired moves an expired processing turn to failed and emits PROCESS_INTERRUPTED", async () => {
    const { user, turn } = await createQueuedTurn();
    const claimed = await worker.claimTurn(turn.turnId);

    assert.ok(claimed);

    await ChatTurn.updateOne(
      { _id: claimed.turn._id },
      { $set: { leaseUntil: new Date(Date.now() - 1000) } },
    );

    const { io, events } = makeIoSpy();
    worker.setIo(io);

    await worker.recoverExpired();

    const persisted = await ChatTurn.findById(claimed.turn._id).lean();

    assert.equal(persisted.status, "failed");
    assert.equal(persisted.error.code, "PROCESS_INTERRUPTED");
    assert.equal(persisted.error.retryable, true);
    assert.equal(persisted.leaseToken, null);
    assert.equal(persisted.leaseUntil, null);

    assert.equal(events.length, 1);
    assert.equal(events[0].userId, user._id.toString());
    assert.equal(events[0].event, "chat:error");
    assert.equal(events[0].payload.turnId, turn.turnId);
    assert.equal(events[0].payload.type, "failed");
    assert.equal(events[0].payload.payload.error.code, "PROCESS_INTERRUPTED");
  });

  test("concurrent recoverExpired calls recover one expired turn only once", async () => {
    const { turn } = await createQueuedTurn();
    const claimed = await worker.claimTurn(turn.turnId);
    assert.ok(claimed);

    await ChatTurn.updateOne(
      { _id: claimed.turn._id },
      { $set: { leaseUntil: new Date(Date.now() - 1000) } },
    );

    const { io, events } = makeIoSpy();
    worker.setIo(io);

    await Promise.all([
      worker.recoverExpired(),
      worker.recoverExpired(),
      worker.recoverExpired(),
      worker.recoverExpired(),
      worker.recoverExpired(),
    ]);

    const persisted = await ChatTurn.findById(claimed.turn._id).lean();

    assert.equal(persisted.status, "failed");
    assert.equal(persisted.error.code, "PROCESS_INTERRUPTED");
    assert.equal(events.length, 1);
    assert.equal(
      await ChatTurn.countDocuments({ turnId: turn.turnId, status: "failed" }),
      1,
    );
  });

  test("recoverExpired does not recover a processing turn whose lease was renewed", async () => {
    const { turn } = await createQueuedTurn();
    const claimed = await worker.claimTurn(turn.turnId);
    assert.ok(claimed);

    await ChatTurn.updateOne(
      { _id: claimed.turn._id },
      { $set: { leaseUntil: new Date(Date.now() + 60_000) } },
    );

    const { io, events } = makeIoSpy();
    worker.setIo(io);

    await worker.recoverExpired();

    const persisted = await ChatTurn.findById(claimed.turn._id).lean();

    assert.equal(persisted.status, "processing");
    assert.equal(persisted.leaseToken, claimed.leaseToken);
    assert.ok(persisted.leaseUntil > new Date());
    assert.equal(events.length, 0);
  });

  test("stale worker heartbeat cannot renew a lease after recovery", async () => {
    const { turn } = await createQueuedTurn();
    const claimed = await worker.claimTurn(turn.turnId);
    assert.ok(claimed);

    await ChatTurn.updateOne(
      { _id: claimed.turn._id },
      { $set: { leaseUntil: new Date(Date.now() - 1000) } },
    );

    await worker.recoverExpired();

    const loaded = await ChatTurn.findById(claimed.turn._id).lean();
    assert.equal(loaded.status, "failed");
    assert.equal(loaded.leaseToken, null);

    const renewed = await worker.heartbeat(claimed.turn, claimed.leaseToken);
    assert.equal(renewed, false);

    const after = await ChatTurn.findById(claimed.turn._id).lean();
    assert.equal(after.status, "failed");
    assert.equal(after.leaseToken, null);
    assert.equal(after.leaseUntil, null);
  });

  test("stale worker cannot write partial content after recovery", async () => {
    const { turn } = await createQueuedTurn();
    const claimed = await worker.claimTurn(turn.turnId);
    assert.ok(claimed);

    await ChatTurn.updateOne(
      { _id: claimed.turn._id },
      { $set: { leaseUntil: new Date(Date.now() - 1000) } },
    );

    await worker.recoverExpired();

    const result = await worker.updatePartial(
      claimed.turn,
      claimed.leaseToken,
      "stale worker output",
      1,
    );

    assert.equal(result, false);

    const persisted = await ChatTurn.findById(claimed.turn._id).lean();
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.partialContent, "");
    assert.equal(persisted.lastSeq, 0);
  });
}
