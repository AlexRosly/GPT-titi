const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateChatSend,
  validateTurnRequest,
  buildRequestHash,
} = require("../src/services/chatDeliveryV2/protocol");

const id = "123e4567-e89b-42d3-a456-426614174000";
const turnId = "223e4567-e89b-42d3-a456-426614174001";

const send = (payload) => ({
  protocolVersion: 2,
  event: "chat:send",
  type: "request",
  payload,
});

test("valid v2 send envelope is accepted", () => {
  assert.deepEqual(validateChatSend(send({
    clientMessageId: id,
    conversationId: "507f1f77bcf86cd799439011",
    modelId: "gpt-4o-mini",
    message: "hello",
    files: [],
  })), {
    clientMessageId: id,
    conversationId: "507f1f77bcf86cd799439011",
    modelId: "gpt-4o-mini",
    message: "hello",
    files: [],
  });
});

test("unknown envelope fields are rejected", () => {
  assert.throws(() => validateChatSend({ ...send({
    clientMessageId: id,
    conversationId: "507f1f77bcf86cd799439011",
    modelId: "gpt-4o-mini",
    message: "hello",
  }), userId: "spoof" }), (error) => error.protocolError.code === "INVALID_ENVELOPE");
});

test("clientMessageId must be UUID v4", () => {
  assert.throws(() => validateChatSend(send({
    clientMessageId: "not-a-uuid",
    conversationId: "507f1f77bcf86cd799439011",
    modelId: "gpt-4o-mini",
    message: "hello",
  })), (error) => error.protocolError.code === "INVALID_CLIENT_MESSAGE_ID");
});

test("conversationId must be a Mongo ObjectId", () => {
  assert.throws(() => validateChatSend(send({
    clientMessageId: id,
    conversationId: "bad-id",
    modelId: "gpt-4o-mini",
    message: "hello",
  })), (error) => error.protocolError.code === "INVALID_CONVERSATION_ID");
});

test("turn request accepts a UUID v4", () => {
  assert.deepEqual(validateTurnRequest({
    protocolVersion: 2,
    event: "chat:status",
    type: "request",
    payload: { turnId },
  }, "chat:status"), { turnId });
});

test("status cannot carry extra fields", () => {
  assert.throws(() => validateTurnRequest({
    protocolVersion: 2,
    event: "chat:status",
    type: "request",
    payload: { turnId, userId: "spoof" },
  }, "chat:status"), (error) => error.protocolError.code === "INVALID_ENVELOPE");
});

test("request hash is deterministic", () => {
  const a = buildRequestHash({
    userId: "u",
    conversationId: "c",
    modelId: "m",
    message: "hello",
    files: [{ id: "f1" }, { id: "f2" }],
  });
  const b = buildRequestHash({
    userId: "u",
    conversationId: "c",
    modelId: "m",
    message: "hello",
    files: [{ id: "f1" }, { id: "f2" }],
  });
  assert.equal(a, b);
});

test("file order changes the request hash", () => {
  const a = buildRequestHash({ userId: "u", conversationId: "c", modelId: "m", message: "hello", files: [{ id: "f1" }, { id: "f2" }] });
  const b = buildRequestHash({ userId: "u", conversationId: "c", modelId: "m", message: "hello", files: [{ id: "f2" }, { id: "f1" }] });
  assert.notEqual(a, b);
});
