// require("dotenv").config();

// const crypto = require("crypto");
// const test = require("node:test");
// const assert = require("node:assert/strict");
// const mongoose = require("mongoose");

// const TEST_MONGO_URI = process.env.CHAT_V2_TEST_MONGO_URI;
// const TEST_DB_BASE = process.env.CHAT_V2_TEST_DB || "gpt_titi_chat_v2_test";
// const TEST_DB_NAME = `${TEST_DB_BASE}_integration_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;

// if (!TEST_MONGO_URI) {
//   test(
//     "Chat Delivery v2 integration tests require CHAT_V2_TEST_MONGO_URI",
//     { skip: "Set CHAT_V2_TEST_MONGO_URI to a MongoDB replica set/Atlas test cluster." },
//     () => {},
//   );
// } else {
//   if (!/test/i.test(TEST_DB_NAME)) {
//     throw new Error(
//       `Refusing to run Chat Delivery v2 integration tests against database '${TEST_DB_NAME}'. ` +
//         "CHAT_V2_TEST_DB must contain the word 'test'.",
//     );
//   }

//   const {
//     User,
//     ChatModels,
//     ChatMessage,
//     ChatConversation,
//     ChatTurn,
//     ChatBillingLedger,
//   } = require("../../src/models");
//   const acceptTurn = require("../../src/services/chatDeliveryV2/acceptTurn");
//   const { claimTurn } = require("../../src/services/chatDeliveryV2/worker");
//   const {
//     finalizeChargeInTransaction,
//   } = require("../../src/services/finalizeCharge");

//   const MODEL_PRICES = {
//     inputPerM: 0.15,
//     outputPerM: 0.6,
//   };

//   const makeId = () => crypto.randomUUID();

//   const createFixture = async ({ appTokens = 10000 } = {}) => {
//     const suffix = makeId();
//     const modelId = `chat-v2-test-model-${suffix}`;

//     const user = await User.create({
//       email: `chat-v2-${suffix}@example.test`,
//       name: "Chat v2 integration user",
//       status: "active",
//       appTokens,
//     });

//     const model = await ChatModels.create({
//       modelId,
//       label: "Chat v2 integration model",
//       category: "chat",
//       enabled: true,
//       inputPerM: MODEL_PRICES.inputPerM,
//       outputPerM: MODEL_PRICES.outputPerM,
//     });

//     const conversation = await ChatConversation.create({
//       user: user._id,
//       title: "Chat Delivery v2 integration test",
//       modelId,
//       archived: false,
//     });

//     return { user, model, conversation, modelId };
//   };

//   const makePayload = ({ conversationId, modelId, clientMessageId = makeId(), message = "hello" }) => ({
//     clientMessageId,
//     conversationId: conversationId.toString(),
//     modelId,
//     message,
//     files: [],
//   });

//   const countTurnMessages = async (turnId) => ({
//     user: await ChatMessage.countDocuments({ turnId, role: "user" }),
//     assistant: await ChatMessage.countDocuments({ turnId, role: "assistant" }),
//   });

//   const applyBilling = async ({ turnId, userId, modelId, usage }) => {
//     const session = await mongoose.startSession();
//     let result;

//     try {
//       await session.withTransaction(async () => {
//         result = await finalizeChargeInTransaction({
//           session,
//           turnId,
//           userId,
//           modelId,
//           usage,
//         });
//       });
//     } finally {
//       await session.endSession();
//     }

//     return result;
//   };

//   test.before(async () => {
//     await mongoose.connect(TEST_MONGO_URI, { dbName: TEST_DB_NAME });

//     // Integration tests intentionally own this dedicated test database.
//     await mongoose.connection.db.dropDatabase();

//     await Promise.all([
//       User.createIndexes(),
//       ChatModels.createIndexes(),
//       ChatConversation.createIndexes(),
//       ChatTurn.createIndexes(),
//       ChatBillingLedger.createIndexes(),
//       ChatMessage.createIndexes(),
//     ]);
//   });

//   test.after(async () => {
//     if (mongoose.connection.readyState !== 0) {
//       await mongoose.connection.db.dropDatabase();
//       await mongoose.disconnect();
//     }
//   });

//   test("acceptTurn durably creates exactly one queued turn and one correlated user message", async () => {
//     const { user, conversation, modelId } = await createFixture();
//     const payload = makePayload({ conversationId: conversation._id, modelId });

//     const result = await acceptTurn({ userId: user._id, payload });

//     assert.equal(result.disposition, "accepted");
//     assert.match(result.turn.turnId, /^[0-9a-f-]{36}$/i);
//     assert.equal(result.turn.status, "queued");
//     assert.equal(result.turn.attempt, 1);

//     const persistedTurn = await ChatTurn.findOne({
//       user: user._id,
//       clientMessageId: payload.clientMessageId,
//     }).lean();

//     assert.ok(persistedTurn);
//     assert.equal(persistedTurn.turnId, result.turn.turnId);
//     assert.equal(persistedTurn.requestHash, result.turn.requestHash);

//     const messages = await countTurnMessages(result.turn.turnId);
//     assert.deepEqual(messages, { user: 1, assistant: 0 });

//     const userMessage = await ChatMessage.findOne({
//       turnId: result.turn.turnId,
//       role: "user",
//     }).lean();

//     assert.ok(userMessage);
//     assert.equal(userMessage.clientMessageId, payload.clientMessageId);
//     assert.equal(userMessage.attempt, 1);
//     assert.equal(userMessage.content, payload.message);
//     assert.equal(userMessage.conversation.toString(), conversation._id.toString());
//   });

//   test("sequential duplicate returns the same turn and creates no second message", async () => {
//     const { user, conversation, modelId } = await createFixture();
//     const payload = makePayload({ conversationId: conversation._id, modelId });

//     const first = await acceptTurn({ userId: user._id, payload });
//     const second = await acceptTurn({ userId: user._id, payload });

//     assert.equal(first.disposition, "accepted");
//     assert.equal(second.disposition, "duplicate");
//     assert.equal(second.turn.turnId, first.turn.turnId);

//     assert.equal(
//       await ChatTurn.countDocuments({
//         user: user._id,
//         clientMessageId: payload.clientMessageId,
//       }),
//       1,
//     );

//     assert.deepEqual(await countTurnMessages(first.turn.turnId), {
//       user: 1,
//       assistant: 0,
//     });
//   });

//   test("same clientMessageId with a changed payload returns IDEMPOTENCY_CONFLICT", async () => {
//     const { user, conversation, modelId } = await createFixture();
//     const clientMessageId = makeId();
//     const firstPayload = makePayload({
//       conversationId: conversation._id,
//       modelId,
//       clientMessageId,
//       message: "original",
//     });
//     const conflictingPayload = {
//       ...firstPayload,
//       message: "changed",
//     };

//     const first = await acceptTurn({ userId: user._id, payload: firstPayload });

//     await assert.rejects(
//       acceptTurn({ userId: user._id, payload: conflictingPayload }),
//       (error) => error?.protocolError?.code === "IDEMPOTENCY_CONFLICT",
//     );

//     assert.equal(
//       await ChatTurn.countDocuments({ user: user._id, clientMessageId }),
//       1,
//     );
//     assert.deepEqual(await countTurnMessages(first.turn.turnId), {
//       user: 1,
//       assistant: 0,
//     });
//   });

//   test("a user cannot accept a turn in another user's conversation", async () => {
//     const owner = await createFixture();
//     const attacker = await createFixture();
//     const payload = makePayload({
//       conversationId: owner.conversation._id,
//       modelId: owner.modelId,
//     });

//     await assert.rejects(
//       acceptTurn({ userId: attacker.user._id, payload }),
//       (error) => error?.protocolError?.code === "CONVERSATION_NOT_FOUND",
//     );

//     assert.equal(
//       await ChatTurn.countDocuments({ clientMessageId: payload.clientMessageId }),
//       0,
//     );
//     assert.equal(
//       await ChatMessage.countDocuments({
//         user: attacker.user._id,
//         conversation: owner.conversation._id,
//       }),
//       0,
//     );
//   });

//   test("missing model is rejected before ChatTurn or ChatMessage creation", async () => {
//     const { user, conversation } = await createFixture();
//     const payload = makePayload({
//       conversationId: conversation._id,
//       modelId: `missing-model-${makeId()}`,
//     });

//     await assert.rejects(
//       acceptTurn({ userId: user._id, payload }),
//       (error) => error?.protocolError?.code === "MODEL_NOT_AVAILABLE",
//     );

//     assert.equal(
//       await ChatTurn.countDocuments({ clientMessageId: payload.clientMessageId }),
//       0,
//     );
//     assert.equal(
//       await ChatMessage.countDocuments({ clientMessageId: payload.clientMessageId }),
//       0,
//     );
//   });

//   test("insufficient balance is rejected before ChatTurn or ChatMessage creation", async () => {
//     const { user, conversation, modelId } = await createFixture({ appTokens: -1000 });
//     const payload = makePayload({
//       conversationId: conversation._id,
//       modelId,
//       message: "This request must fail preflight balance validation.",
//     });

//     await assert.rejects(
//       acceptTurn({ userId: user._id, payload }),
//       (error) => error?.protocolError?.code === "INSUFFICIENT_BALANCE",
//     );

//     assert.equal(
//       await ChatTurn.countDocuments({ clientMessageId: payload.clientMessageId }),
//       0,
//     );
//     assert.equal(
//       await ChatMessage.countDocuments({ clientMessageId: payload.clientMessageId }),
//       0,
//     );
//   });

//   test("ChatMessage partial unique indexes allow one user and one assistant per turn, but reject duplicates by role", async () => {
//     const { user, conversation, modelId } = await createFixture();
//     const turnId = makeId();

//     await ChatMessage.create({
//       user: user._id,
//       conversation: conversation._id,
//       role: "user",
//       content: "user",
//       modelId,
//       turnId,
//       clientMessageId: makeId(),
//       attempt: 1,
//     });

//     await ChatMessage.create({
//       user: user._id,
//       conversation: conversation._id,
//       role: "assistant",
//       content: "assistant",
//       modelId,
//       turnId,
//       attempt: 1,
//     });

//     await assert.rejects(
//       ChatMessage.create({
//         user: user._id,
//         conversation: conversation._id,
//         role: "user",
//         content: "duplicate user",
//         modelId,
//         turnId,
//         clientMessageId: makeId(),
//         attempt: 1,
//       }),
//       (error) => error?.code === 11000,
//     );

//     await assert.rejects(
//       ChatMessage.create({
//         user: user._id,
//         conversation: conversation._id,
//         role: "assistant",
//         content: "duplicate assistant",
//         modelId,
//         turnId,
//         attempt: 1,
//       }),
//       (error) => error?.code === 11000,
//     );

//     assert.deepEqual(await countTurnMessages(turnId), {
//       user: 1,
//       assistant: 1,
//     });
//   });

//   test("concurrent claimTurn calls produce exactly one processing worker lease", async () => {
//     const { user, conversation, modelId } = await createFixture();
//     const payload = makePayload({ conversationId: conversation._id, modelId });
//     const accepted = await acceptTurn({ userId: user._id, payload });

//     const claims = await Promise.all(
//       Array.from({ length: 20 }, () => claimTurn(accepted.turn.turnId)),
//     );

//     const successfulClaims = claims.filter(Boolean);
//     assert.equal(successfulClaims.length, 1);

//     const persisted = await ChatTurn.findOne({ turnId: accepted.turn.turnId }).lean();
//     assert.equal(persisted.status, "processing");
//     assert.equal(persisted.attempt, 1);
//     assert.equal(typeof persisted.leaseToken, "string");
//     assert.ok(persisted.leaseUntil instanceof Date);
//   });

//   test("v2 billing ledger makes repeated billing for one turn idempotent", async () => {
//     const { user, conversation, modelId } = await createFixture({ appTokens: 10000 });
//     const payload = makePayload({ conversationId: conversation._id, modelId });
//     const accepted = await acceptTurn({ userId: user._id, payload });
//     const before = await User.findById(user._id).lean();
//     const usage = {
//       prompt_tokens: 1000,
//       completion_tokens: 500,
//       total_tokens: 1500,
//     };

//     const first = await applyBilling({
//       turnId: accepted.turn.turnId,
//       userId: user._id,
//       modelId,
//       usage,
//     });
//     const second = await applyBilling({
//       turnId: accepted.turn.turnId,
//       userId: user._id,
//       modelId,
//       usage,
//     });

//     const after = await User.findById(user._id).lean();

//     assert.equal(first.alreadyApplied, false);
//     assert.equal(second.alreadyApplied, true);
//     assert.equal(await ChatBillingLedger.countDocuments({ turnId: accepted.turn.turnId }), 1);
//     assert.equal(before.appTokens - after.appTokens, first.appTokens);
//     assert.equal(second.balance, first.balance);
//     assert.equal(after.appTokens, first.balance);
//   });
// }
require("dotenv").config();

const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

// const TEST_MONGO_URI = process.env.CHAT_V2_TEST_MONGO_URI;
// const TEST_DB_BASE = process.env.CHAT_V2_TEST_DB || "gpt_titi_chat_v2_test";
// const TEST_DB_NAME = `${TEST_DB_BASE}_integration_${process.pid}_${crypto
//   .randomUUID()
//   .slice(0, 8)}`;
const TEST_MONGO_URI = process.env.CHAT_V2_TEST_MONGO_URI;
const TEST_DB_BASE = process.env.CHAT_V2_TEST_DB || "gpt_titi_chat_v2_test";

if (!/test/i.test(TEST_DB_BASE)) {
  throw new Error(
    `Refusing to run Chat Delivery v2 integration tests against database '${TEST_DB_BASE}'. ` +
      "CHAT_V2_TEST_DB must contain the word 'test'.",
  );
}

const TEST_DB_NAME = `gpt_titi_chat_v2_i_${process.pid}_${crypto
  .randomBytes(3)
  .toString("hex")}`;

if (!TEST_MONGO_URI) {
  test(
    "Chat Delivery v2 integration tests require CHAT_V2_TEST_MONGO_URI",
    {
      skip: "Set CHAT_V2_TEST_MONGO_URI to a MongoDB replica set/Atlas test cluster.",
    },
    () => {},
  );
} else {
  // if (!/test/i.test(TEST_DB_NAME)) {
  //   throw new Error(
  //     `Refusing to run Chat Delivery v2 integration tests against database '${TEST_DB_NAME}'. ` +
  //       "CHAT_V2_TEST_DB must contain the word 'test'.",
  //   );
  // }

  const {
    User,
    ChatModels,
    ChatMessage,
    ChatConversation,
    ChatTurn,
    ChatBillingLedger,
  } = require("../../src/models");

  const acceptTurn = require("../../src/services/chatDeliveryV2/acceptTurn");
  const { claimTurn } = require("../../src/services/chatDeliveryV2/worker");
  const {
    finalizeChargeInTransaction,
  } = require("../../src/services/finalizeCharge");

  const MODEL_PRICES = {
    inputPerM: 0.15,
    outputPerM: 0.6,
  };

  const makeId = () => crypto.randomUUID();

  const createFixture = async ({ appTokens = 10000 } = {}) => {
    const suffix = makeId();
    const modelId = `chat-v2-test-model-${suffix}`;

    const user = await User.create({
      email: `chat-v2-${suffix}@example.test`,
      name: "Chat v2 integration user",
      status: "active",
      appTokens,
    });

    const model = await ChatModels.create({
      modelId,
      label: "Chat v2 integration model",
      category: "chat",
      enabled: true,
      inputPerM: MODEL_PRICES.inputPerM,
      outputPerM: MODEL_PRICES.outputPerM,
    });

    const conversation = await ChatConversation.create({
      user: user._id,
      title: "Chat Delivery v2 integration test",
      modelId,
      archived: false,
    });

    return { user, model, conversation, modelId };
  };

  const makePayload = ({
    conversationId,
    modelId,
    clientMessageId = makeId(),
    message = "hello",
  }) => ({
    clientMessageId,
    conversationId: conversationId.toString(),
    modelId,
    message,
    files: [],
  });

  const countTurnMessages = async (turnId) => ({
    user: await ChatMessage.countDocuments({ turnId, role: "user" }),
    assistant: await ChatMessage.countDocuments({
      turnId,
      role: "assistant",
    }),
  });

  const applyBilling = async ({ turnId, userId, modelId, usage }) => {
    const session = await mongoose.startSession();
    let result;

    try {
      await session.withTransaction(async () => {
        result = await finalizeChargeInTransaction({
          session,
          turnId,
          userId,
          modelId,
          usage,
        });
      });
    } finally {
      await session.endSession();
    }

    return result;
  };

  test.before(async () => {
    await mongoose.connect(TEST_MONGO_URI, {
      dbName: TEST_DB_NAME,
    });

    await Promise.all([
      User.createIndexes(),
      ChatModels.createIndexes(),
      ChatConversation.createIndexes(),
      ChatTurn.createIndexes(),
      ChatBillingLedger.createIndexes(),
      ChatMessage.createIndexes(),
    ]);
  });

  test.after(async () => {
    // Do NOT use dropDatabase() here.
    //
    // The integration suite already runs against a unique database:
    //   <base>_integration_<pid>_<uuid>
    //
    // MongoDB/Atlas may keep dropDatabase() in DatabaseDropPending state,
    // which can make the next test suite fail before it even starts.
    //
    // Clean the collections instead and then close the connection.
    try {
      await Promise.all([
        User.deleteMany({}),
        ChatModels.deleteMany({}),
        ChatConversation.deleteMany({}),
        ChatTurn.deleteMany({}),
        ChatBillingLedger.deleteMany({}),
        ChatMessage.deleteMany({}),
      ]);
    } finally {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    }
  });

  test("acceptTurn durably creates exactly one queued turn and one correlated user message", async () => {
    const { user, conversation, modelId } = await createFixture();
    const payload = makePayload({
      conversationId: conversation._id,
      modelId,
    });

    const result = await acceptTurn({
      userId: user._id,
      payload,
    });

    assert.equal(result.disposition, "accepted");
    assert.match(result.turn.turnId, /^[0-9a-f-]{36}$/i);
    assert.equal(result.turn.status, "queued");
    assert.equal(result.turn.attempt, 1);

    const persistedTurn = await ChatTurn.findOne({
      user: user._id,
      clientMessageId: payload.clientMessageId,
    }).lean();

    assert.ok(persistedTurn);
    assert.equal(persistedTurn.turnId, result.turn.turnId);
    assert.equal(persistedTurn.requestHash, result.turn.requestHash);

    const messages = await countTurnMessages(result.turn.turnId);

    assert.deepEqual(messages, {
      user: 1,
      assistant: 0,
    });

    const userMessage = await ChatMessage.findOne({
      turnId: result.turn.turnId,
      role: "user",
    }).lean();

    assert.ok(userMessage);
    assert.equal(userMessage.clientMessageId, payload.clientMessageId);
    assert.equal(userMessage.attempt, 1);
    assert.equal(userMessage.content, payload.message);
    assert.equal(
      userMessage.conversation.toString(),
      conversation._id.toString(),
    );
  });

  test("sequential duplicate returns the same turn and creates no second message", async () => {
    const { user, conversation, modelId } = await createFixture();

    const payload = makePayload({
      conversationId: conversation._id,
      modelId,
    });

    const first = await acceptTurn({
      userId: user._id,
      payload,
    });

    const second = await acceptTurn({
      userId: user._id,
      payload,
    });

    assert.equal(first.disposition, "accepted");
    assert.equal(second.disposition, "duplicate");
    assert.equal(second.turn.turnId, first.turn.turnId);

    assert.equal(
      await ChatTurn.countDocuments({
        user: user._id,
        clientMessageId: payload.clientMessageId,
      }),
      1,
    );

    assert.deepEqual(await countTurnMessages(first.turn.turnId), {
      user: 1,
      assistant: 0,
    });
  });

  test("same clientMessageId with a changed payload returns IDEMPOTENCY_CONFLICT", async () => {
    const { user, conversation, modelId } = await createFixture();

    const clientMessageId = makeId();

    const firstPayload = makePayload({
      conversationId: conversation._id,
      modelId,
      clientMessageId,
      message: "original",
    });

    const conflictingPayload = {
      ...firstPayload,
      message: "changed",
    };

    const first = await acceptTurn({
      userId: user._id,
      payload: firstPayload,
    });

    await assert.rejects(
      acceptTurn({
        userId: user._id,
        payload: conflictingPayload,
      }),
      (error) => error?.protocolError?.code === "IDEMPOTENCY_CONFLICT",
    );

    assert.equal(
      await ChatTurn.countDocuments({
        user: user._id,
        clientMessageId,
      }),
      1,
    );

    assert.deepEqual(await countTurnMessages(first.turn.turnId), {
      user: 1,
      assistant: 0,
    });
  });

  test("a user cannot accept a turn in another user's conversation", async () => {
    const owner = await createFixture();
    const attacker = await createFixture();

    const payload = makePayload({
      conversationId: owner.conversation._id,
      modelId: owner.modelId,
    });

    await assert.rejects(
      acceptTurn({
        userId: attacker.user._id,
        payload,
      }),
      (error) => error?.protocolError?.code === "CONVERSATION_NOT_FOUND",
    );

    assert.equal(
      await ChatTurn.countDocuments({
        clientMessageId: payload.clientMessageId,
      }),
      0,
    );

    assert.equal(
      await ChatMessage.countDocuments({
        user: attacker.user._id,
        conversation: owner.conversation._id,
      }),
      0,
    );
  });

  test("missing model is rejected before ChatTurn or ChatMessage creation", async () => {
    const { user, conversation } = await createFixture();

    const payload = makePayload({
      conversationId: conversation._id,
      modelId: `missing-model-${makeId()}`,
    });

    await assert.rejects(
      acceptTurn({
        userId: user._id,
        payload,
      }),
      (error) => error?.protocolError?.code === "MODEL_NOT_AVAILABLE",
    );

    assert.equal(
      await ChatTurn.countDocuments({
        clientMessageId: payload.clientMessageId,
      }),
      0,
    );

    assert.equal(
      await ChatMessage.countDocuments({
        clientMessageId: payload.clientMessageId,
      }),
      0,
    );
  });

  test("insufficient balance is rejected before ChatTurn or ChatMessage creation", async () => {
    const { user, conversation, modelId } = await createFixture({
      appTokens: -1000,
    });

    const payload = makePayload({
      conversationId: conversation._id,
      modelId,
      message: "This request must fail preflight balance validation.",
    });

    await assert.rejects(
      acceptTurn({
        userId: user._id,
        payload,
      }),
      (error) => error?.protocolError?.code === "INSUFFICIENT_BALANCE",
    );

    assert.equal(
      await ChatTurn.countDocuments({
        clientMessageId: payload.clientMessageId,
      }),
      0,
    );

    assert.equal(
      await ChatMessage.countDocuments({
        clientMessageId: payload.clientMessageId,
      }),
      0,
    );
  });

  test("ChatMessage partial unique indexes allow one user and one assistant per turn, but reject duplicates by role", async () => {
    const { user, conversation, modelId } = await createFixture();

    const turnId = makeId();

    await ChatMessage.create({
      user: user._id,
      conversation: conversation._id,
      role: "user",
      content: "user",
      modelId,
      turnId,
      clientMessageId: makeId(),
      attempt: 1,
    });

    await ChatMessage.create({
      user: user._id,
      conversation: conversation._id,
      role: "assistant",
      content: "assistant",
      modelId,
      turnId,
      attempt: 1,
    });

    await assert.rejects(
      ChatMessage.create({
        user: user._id,
        conversation: conversation._id,
        role: "user",
        content: "duplicate user",
        modelId,
        turnId,
        clientMessageId: makeId(),
        attempt: 1,
      }),
      (error) => error?.code === 11000,
    );

    await assert.rejects(
      ChatMessage.create({
        user: user._id,
        conversation: conversation._id,
        role: "assistant",
        content: "duplicate assistant",
        modelId,
        turnId,
        attempt: 1,
      }),
      (error) => error?.code === 11000,
    );

    assert.deepEqual(await countTurnMessages(turnId), {
      user: 1,
      assistant: 1,
    });
  });

  test("concurrent claimTurn calls produce exactly one processing worker lease", async () => {
    const { user, conversation, modelId } = await createFixture();

    const payload = makePayload({
      conversationId: conversation._id,
      modelId,
    });

    const accepted = await acceptTurn({
      userId: user._id,
      payload,
    });

    const claims = await Promise.all(
      Array.from({ length: 20 }, () => claimTurn(accepted.turn.turnId)),
    );

    const successfulClaims = claims.filter(Boolean);

    assert.equal(successfulClaims.length, 1);

    const persisted = await ChatTurn.findOne({
      turnId: accepted.turn.turnId,
    }).lean();

    assert.equal(persisted.status, "processing");
    assert.equal(persisted.attempt, 1);
    assert.equal(typeof persisted.leaseToken, "string");
    assert.ok(persisted.leaseUntil instanceof Date);
  });

  test("v2 billing ledger makes repeated billing for one turn idempotent", async () => {
    const { user, conversation, modelId } = await createFixture({
      appTokens: 10000,
    });

    const payload = makePayload({
      conversationId: conversation._id,
      modelId,
    });

    const accepted = await acceptTurn({
      userId: user._id,
      payload,
    });

    const before = await User.findById(user._id).lean();

    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    };

    const first = await applyBilling({
      turnId: accepted.turn.turnId,
      userId: user._id,
      modelId,
      usage,
    });

    const second = await applyBilling({
      turnId: accepted.turn.turnId,
      userId: user._id,
      modelId,
      usage,
    });

    const after = await User.findById(user._id).lean();

    assert.equal(first.alreadyApplied, false);
    assert.equal(second.alreadyApplied, true);

    assert.equal(
      await ChatBillingLedger.countDocuments({
        turnId: accepted.turn.turnId,
      }),
      1,
    );

    assert.equal(before.appTokens - after.appTokens, first.appTokens);

    assert.equal(second.balance, first.balance);
    assert.equal(after.appTokens, first.balance);
  });
}
