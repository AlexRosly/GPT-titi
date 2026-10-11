const test = require("node:test");
const assert = require("node:assert/strict");
const { parseQuery, dayStart, encodeCursor, decodeCursor } = require("../src/services/tokenHistoryQuery");

test("Kyiv local days include the entire DST day, not a fixed 24 hours", () => {
  for (const [date, hours] of [["2026-03-29", 23], ["2026-10-25", 25]]) {
    const query = parseQuery({ from: date, to: date, timeZone: "Europe/Kyiv" });
    assert.equal((query.createdAt.$lt - query.createdAt.$gte) / 3600000, hours);
  }
  assert.equal(dayStart("2026-10-11", "Europe/Kyiv").toISOString(), "2026-10-10T21:00:00.000Z");
});
test("query rejects invalid dates, objects, time zones, limits and modes", () => {
  for (const query of [{ from: "2026-02-30" }, { from: "2026-10-12", to: "2026-10-11" },
    { timeZone: "fake-zone" }, { mode: "bad" }, { type: "$ne" }, { limit: "101", mode: "detailed" },
    { from: { $gt: "2020" } }, { limit: "0" }, { limit: "2.5" }, { type: ["usage"] }]) {
    assert.throws(() => parseQuery(query), { code: "INVALID_HISTORY_QUERY" });
  }
});
test("cursor is tied to the account, date filters and time zone", () => {
  const options = parseQuery({ mode: "detailed", type: "usage", from: "2026-10-11", timeZone: "Europe/Kyiv" });
  const cursor = encodeCursor("a", options, { at: "2026-10-11T00:00:00.000Z", id: "000000000000000000000001" });
  assert.equal(decodeCursor("a", { ...options, cursor }).at.toISOString(), "2026-10-11T00:00:00.000Z");
  for (const [user, opts] of [["b", options], ["a", { ...options, type: "all" }], ["a", { ...options, timeZone: "UTC" }]]) {
    assert.throws(() => decodeCursor(user, { ...opts, cursor }), { code: "INVALID_HISTORY_QUERY" });
  }
  assert.throws(() => decodeCursor("a", { ...options, cursor: "garbage" }), { code: "INVALID_HISTORY_QUERY" });
});
