const test = require("node:test");
const assert = require("node:assert/strict");
const historyMessageDto = require("../../src/services/chatDeliveryV2/historyMessageDto");

test("history DTO preserves v2 correlation fields and adds id", () => {
  const message = {
    _id: { toString: () => "message-1" },
    role: "assistant",
    content: "done",
    modelId: "gpt-test",
    tokens: 12,
    attachments: [],
    turnId: "turn-1",
    clientMessageId: null,
    attempt: 2,
  };

  const dto = historyMessageDto(message);
  assert.equal(dto.id, "message-1");
  assert.equal(dto.turnId, "turn-1");
  assert.equal(dto.clientMessageId, null);
  assert.equal(dto.attempt, 2);
  assert.equal(dto.content, "done");
});

test("history DTO remains backward-compatible for legacy messages", () => {
  const dto = historyMessageDto({
    _id: { toString: () => "legacy-1" },
    role: "user",
    content: "legacy",
  });

  assert.equal(dto.id, "legacy-1");
  assert.equal(dto.turnId, null);
  assert.equal(dto.clientMessageId, null);
  assert.equal(dto.attempt, null);
  assert.equal(dto.content, "legacy");
});
