require("dotenv").config();

const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const TEST_MONGO_URI = process.env.CHAT_V2_TEST_MONGO_URI;
const TEST_DB_NAME = `gpt_titi_test_r_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;

if (!TEST_MONGO_URI) {
  test(
    "Chat Delivery v2 reliability integration requires CHAT_V2_TEST_MONGO_URI",
    {
      skip: "Set CHAT_V2_TEST_MONGO_URI to a MongoDB replica set/Atlas test cluster.",
    },
    () => {},
  );
} else {
  if (TEST_DB_NAME.length > 38 || !/^gpt_titi_test/i.test(TEST_DB_NAME)) {
    throw new Error(`Unsafe Chat Delivery v2 reliability test DB '${TEST_DB_NAME}'.`);
  }

  const {
    User,
    ChatModels,
    ChatConversation,
    ChatTurn,
    ChatMessage,
    ChatBillingLedger,
  } = require("../../src/models");
  const acceptTurn = require("../../src/services/chatDeliveryV2/acceptTurn");
  const retryTurn = require("../../src/services/chatDeliveryV2/retryTurn");
  const worker = require("../../src/services/chatDeliveryV2/worker");

  const makeId = () => crypto.randomUUID();
  const usage = {
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
  };

  const createFixture = async ({ appTokens = 10000 } = {}) => {
    const suffix = makeId();
    const modelId = `chat-v2-reliability-${suffix}`;

    const user = await User.create({
      email: `chat-v2-reliability-${suffix}@example.test`,
      name: "Chat v2 reliability user",
      status: "active",
      appTokens,
    });

    await ChatModels.create({
      modelId,
      label: "Chat v2 reliability model",
      category: "chat",
      enabled: true,
      inputPerM: 0.15,
      outputPerM: 0.6,
    });

    const conversation = await ChatConversation.create({
      user: user._id,
      title: "Chat Delivery v2 reliability test",
      modelId,
      archived: false,
    });

    const accepted = await acceptTurn({
      userId: user._id,
      payload: {
        clientMessageId: makeId(),
        conversationId: conversation._id.toString(),
        modelId,
        message: "reliability test",
        files: [],
      },
    });

    return { user, conversation, modelId, turn: accepted.turn };
  };

  const expireAndRecover = async (claimed) => {
    await ChatTurn.updateOne(
      { _id: claimed.turn._id },
      { $set: { leaseUntil: new Date(Date.now() - 1000) } },
    );
    await worker.recoverExpired();
    return ChatTurn.findById(claimed.turn._id).lean();
  };

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
  });

  test.after(async () => {
    worker.setIo(null);

    try {
      await Promise.all([
        User.deleteMany({}),
        ChatModels.deleteMany({}),
        ChatConversation.deleteMany({}),
        ChatTurn.deleteMany({}),
        ChatMessage.deleteMany({}),
        ChatBillingLedger.deleteMany({}),
      ]);
    } finally {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    }
  });

  test("concurrent retry advances a retryable failed turn exactly once", async () => {
    const { user, turn } = await createFixture();
    const claimed = await worker.claimTurn(turn.turnId);
    assert.ok(claimed);

    const failed = await expireAndRecover(claimed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempt, 1);
    assert.equal(failed.error.retryable, true);

    const retries = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        retryTurn({ turnId: turn.turnId, userId: user._id }),
      ),
    );

    const fulfilled = retries.filter((result) => result.status === "fulfilled");
    const rejected = retries.filter((result) => result.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 19);
    assert.ok(
      rejected.every(
        (result) => result.reason?.protocolError?.code === "TURN_NOT_RETRYABLE",
      ),
    );

    const persisted = await ChatTurn.findOne({ turnId: turn.turnId }).lean();
    assert.equal(persisted.status, "queued");
    assert.equal(persisted.attempt, 2);
    assert.equal(persisted.lastSeq, 0);
    assert.equal(persisted.partialContent, "");
    assert.equal(persisted.error, null);
    assert.equal(
      await ChatMessage.countDocuments({ turnId: turn.turnId, role: "user" }),
      1,
    );
  });

  test("old attempt is fenced after retry and cannot partial-write or complete", async () => {
    const { user, turn } = await createFixture();
    const claimedAttempt1 = await worker.claimTurn(turn.turnId);
    assert.ok(claimedAttempt1);

    await expireAndRecover(claimedAttempt1);
    const retried = await retryTurn({ turnId: turn.turnId, userId: user._id });
    assert.equal(retried.attempt, 2);
    assert.equal(retried.status, "queued");

    assert.equal(
      await worker.heartbeat(claimedAttempt1.turn, claimedAttempt1.leaseToken),
      false,
    );
    assert.equal(
      await worker.updatePartial(
        claimedAttempt1.turn,
        claimedAttempt1.leaseToken,
        "stale output",
        1,
      ),
      false,
    );

    await assert.rejects(
      worker.commitCompletion(
        claimedAttempt1.turn,
        claimedAttempt1.leaseToken,
        "stale completion",
        usage,
      ),
      (error) => error?.staleLease === true,
    );

    assert.equal(await ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 0);
    assert.equal(
      await ChatMessage.countDocuments({ turnId: turn.turnId, role: "assistant" }),
      0,
    );
  });

  test("completion is exactly-once when the same worker tries to commit twice", async () => {
    const { user, turn } = await createFixture();
    const claimed = await worker.claimTurn(turn.turnId);
    assert.ok(claimed);

    const before = await User.findById(user._id).lean();
    const first = await worker.commitCompletion(
      claimed.turn,
      claimed.leaseToken,
      "authoritative assistant response",
      usage,
    );

    await assert.rejects(
      worker.commitCompletion(
        claimed.turn,
        claimed.leaseToken,
        "duplicate assistant response",
        usage,
      ),
      (error) => error?.staleLease === true,
    );

    const after = await User.findById(user._id).lean();
    const persisted = await ChatTurn.findOne({ turnId: turn.turnId }).lean();

    assert.equal(persisted.status, "completed");
    assert.equal(persisted.partialContent, "authoritative assistant response");
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 1);
    assert.equal(
      await ChatMessage.countDocuments({ turnId: turn.turnId, role: "assistant" }),
      1,
    );
    assert.equal(before.appTokens - after.appTokens, first.billing.appTokensSpent);
  });

  test("concurrent completion produces one assistant message and one billing debit", async () => {
    const { user, turn } = await createFixture();
    const claimed = await worker.claimTurn(turn.turnId);
    assert.ok(claimed);

    const before = await User.findById(user._id).lean();
    const completions = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        worker.commitCompletion(
          claimed.turn,
          claimed.leaseToken,
          "concurrent authoritative response",
          usage,
        ),
      ),
    );

    const fulfilled = completions.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1);

    const after = await User.findById(user._id).lean();
    const persisted = await ChatTurn.findOne({ turnId: turn.turnId }).lean();
    const ledger = await ChatBillingLedger.findOne({ turnId: turn.turnId }).lean();

    assert.equal(persisted.status, "completed");
    assert.ok(persisted.completedAt instanceof Date);
    assert.ok(persisted.billingAppliedAt instanceof Date);
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 1);
    assert.equal(
      await ChatMessage.countDocuments({ turnId: turn.turnId, role: "assistant" }),
      1,
    );
    assert.equal(before.appTokens - after.appTokens, ledger.appTokensSpent);
  });

  test("retry attempt 2 can complete while the original user message remains exactly once", async () => {
    const { user, turn } = await createFixture();
    const claimedAttempt1 = await worker.claimTurn(turn.turnId);
    assert.ok(claimedAttempt1);

    await expireAndRecover(claimedAttempt1);
    await retryTurn({ turnId: turn.turnId, userId: user._id });

    const claimedAttempt2 = await worker.claimTurn(turn.turnId);
    assert.ok(claimedAttempt2);
    assert.equal(claimedAttempt2.turn.attempt, 2);

    await worker.commitCompletion(
      claimedAttempt2.turn,
      claimedAttempt2.leaseToken,
      "attempt two response",
      usage,
    );

    const persisted = await ChatTurn.findOne({ turnId: turn.turnId }).lean();
    const assistant = await ChatMessage.findOne({
      turnId: turn.turnId,
      role: "assistant",
    }).lean();
    const userMessage = await ChatMessage.findOne({
      turnId: turn.turnId,
      role: "user",
    }).lean();

    assert.equal(persisted.status, "completed");
    assert.equal(persisted.attempt, 2);
    assert.equal(userMessage.attempt, 1);
    assert.equal(assistant.attempt, 2);
    assert.equal(
      await ChatMessage.countDocuments({ turnId: turn.turnId, role: "user" }),
      1,
    );
    assert.equal(
      await ChatMessage.countDocuments({ turnId: turn.turnId, role: "assistant" }),
      1,
    );
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 1);
  });

  test("failed retryable attempt without completion does not bill or create assistant", async () => {
    const { user, turn } = await createFixture();
    const claimed = await worker.claimTurn(turn.turnId);
    assert.ok(claimed);

    const before = await User.findById(user._id).lean();
    const failed = await expireAndRecover(claimed);
    const after = await User.findById(user._id).lean();

    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "PROCESS_INTERRUPTED");
    assert.equal(before.appTokens, after.appTokens);
    assert.equal(await ChatBillingLedger.countDocuments({ turnId: turn.turnId }), 0);
    assert.equal(
      await ChatMessage.countDocuments({ turnId: turn.turnId, role: "assistant" }),
      0,
    );
  });

  test("completed turn is not retryable", async () => {
    const { user, turn } = await createFixture();
    const claimed = await worker.claimTurn(turn.turnId);
    assert.ok(claimed);

    await worker.commitCompletion(
      claimed.turn,
      claimed.leaseToken,
      "completed turn",
      usage,
    );

    await assert.rejects(
      retryTurn({ turnId: turn.turnId, userId: user._id }),
      (error) => error?.protocolError?.code === "TURN_NOT_RETRYABLE",
    );

    const persisted = await ChatTurn.findOne({ turnId: turn.turnId }).lean();
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.attempt, 1);
  });
}
