const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CONVERSATION_SORT,
  PROJECT_SORT,
  buildPinnedAtExpression,
  resolvePinnedAt,
} = require("../src/services/pinning/pinningRules");

test("pin creates a timestamp when resource is unpinned", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");

  assert.equal(
    resolvePinnedAt({ currentPinnedAt: null, pinned: true, now }),
    now,
  );
});

test("duplicate pin preserves the existing timestamp", () => {
  const pinnedAt = new Date("2026-09-01T12:00:00.000Z");
  const now = new Date("2026-09-03T12:00:00.000Z");

  assert.equal(
    resolvePinnedAt({ currentPinnedAt: pinnedAt, pinned: true, now }),
    pinnedAt,
  );
});

test("unpin clears pinnedAt", () => {
  const pinnedAt = new Date("2026-09-01T12:00:00.000Z");

  assert.equal(
    resolvePinnedAt({ currentPinnedAt: pinnedAt, pinned: false, now: new Date() }),
    null,
  );
});

test("duplicate unpin is a safe no-op", () => {
  assert.equal(
    resolvePinnedAt({ currentPinnedAt: null, pinned: false, now: new Date() }),
    null,
  );
});

test("Mongo pin expression preserves pinnedAt or uses server $$NOW", () => {
  assert.deepEqual(buildPinnedAtExpression(true), {
    $ifNull: ["$pinnedAt", "$$NOW"],
  });
});

test("Mongo unpin expression sets pinnedAt to null", () => {
  assert.equal(buildPinnedAtExpression(false), null);
});

test("conversation sort pins first then keeps lastMessageAt order", () => {
  assert.deepEqual(CONVERSATION_SORT, {
    pinnedAt: -1,
    lastMessageAt: -1,
    _id: -1,
  });
});

test("project sort pins first then preserves existing list order", () => {
  assert.deepEqual(PROJECT_SORT, {
    pinnedAt: -1,
    lastMessageAt: -1,
    updatedAt: -1,
    _id: -1,
  });
});
