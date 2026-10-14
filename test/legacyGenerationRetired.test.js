const test = require("node:test");
const assert = require("node:assert/strict");
const gone = require("../src/controllers/chat/legacyGenerationGone");
test("legacy HTTP generation returns a clear retirement response", () => {
  let status; let body;
  const res = { status: (value) => { status = value; return res; }, json: (value) => { body = value; } };
  gone({}, res);
  assert.equal(status, 410); assert.equal(body.code, "CHAT_V2_REQUIRED");
  assert.equal(require("../src/controllers/chat/streamChat"), gone);
  assert.equal(require("../src/controllers/chat/conversation/regenerateLastAnswer"), gone);
});
test("dormant legacy service and socket registration cannot generate", async () => {
  await assert.rejects(require("../src/services/chat")({}), { code: "CHAT_V2_REQUIRED" });
  assert.throws(() => require("../src/controllers/ws/handlers/chatSocket")(), /V2/);
});
