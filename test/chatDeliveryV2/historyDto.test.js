const test = require("node:test");
const assert = require("node:assert/strict");
const historyMessageDto = require("../../src/services/chatDeliveryV2/historyMessageDto");

test("history exposes settled TITI independently of provider completion tokens", () => {
  const dto = historyMessageDto({ role: "assistant", tokens: 174, meta: { appTokens: 430 } });
  assert.equal(dto.tokens, 174);
  assert.deepEqual(dto.billing, { appTokensSpent: 430 });
  assert.equal(historyMessageDto({ toObject: () => ({ role: "assistant", meta: { appTokens: 0 } }) }).billing.appTokensSpent, 0);
});

test("history never fabricates a charge for missing, invalid or user-message billing", () => {
  for (const appTokens of [undefined, null, -1, NaN, Infinity, "430"]) {
    assert.equal(historyMessageDto({ role: "assistant", tokens: 174, meta: { appTokens } }).billing, null);
  }
  assert.equal(historyMessageDto({ role: "user", meta: { appTokens: 430 } }).billing, null);
});

test("both history endpoints expose stored billing and retain owner filters", async () => {
  const modelPath = require.resolve("../../src/models");
  const filesPath = require.resolve("../../src/services/files/messages");
  const previous = [require.cache[modelPath], require.cache[filesPath]];
  const message = { _id: "message-1", role: "assistant", tokens: 174, meta: { appTokens: 430 } };
  let projection;
  const queries = [];
  const query = { sort() { return this; }, limit() { return this; }, select(value) { projection = value; return this; }, async lean() { return [message]; } };
  require.cache[modelPath] = { exports: {
    ChatMessage: { find(filter) { queries.push(filter); return query; } },
    ChatConversation: { findOne(filter) { assert.equal(filter.user, "owner"); return { select: async () => ({ _id: "chat" }) }; } },
  } };
  require.cache[filesPath] = { exports: { hydrate: async (owner, messages) => { assert.equal(owner, "owner"); return messages; } } };
  const controllers = ["../../src/controllers/chat/getChatHistory", "../../src/controllers/chat/conversation/getConversationMessages"];
  try {
    for (const path of controllers) {
      const controller = require(path);
      let result;
      await controller({ user: { id: "owner" }, params: { id: "chat" }, query: {} }, {
        json(value) { result = value; }, status() { assert.fail("history request failed"); },
      });
      const messages = Array.isArray(result) ? result : result.messages;
      assert.equal(messages[0].billing.appTokensSpent, 430);
      assert.equal(messages[0].tokens, 174);
    }
    assert.match(projection, /meta\.appTokens/);
    assert.deepEqual(queries, [{ user: "owner", deleted: null }, { conversation: "chat", user: "owner", deleted: null }]);
  } finally {
    for (const path of controllers) delete require.cache[require.resolve(path)];
    for (const [i, path] of [modelPath, filesPath].entries()) {
      if (previous[i]) require.cache[path] = previous[i]; else delete require.cache[path];
    }
  }
});

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
