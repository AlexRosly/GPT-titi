const test = require("node:test");
const assert = require("node:assert/strict");
const { createScheduler } = require("../../src/services/chatDeliveryV2/scheduler");
const immediate = () => new Promise((resolve) => setImmediate(resolve));

test("overlapping wake-ups respect worker slots and continue after completion", async () => {
  const queue = Array.from({ length: 8 }, (_, id) => ({ id }));
  let running = 0; let maximum = 0; let completed = 0;
  const gates = [];
  const errors = [];
  const scheduler = createScheduler({ concurrency: 2, pollMs: 100000,
    recover: async () => { await immediate(); },
    claim: async () => { await immediate(); return queue.shift(); },
    process: async () => { running += 1; maximum = Math.max(maximum, running);
      await new Promise((resolve) => gates.push(resolve)); running -= 1; completed += 1; },
    onError: (error) => errors.push(error),
  });
  try {
    for (let i = 0; i < 20; i++) scheduler.wake();
    for (let i = 0; i < 200 && completed < 8; i++) {
      await immediate();
      gates.splice(0).forEach((resolve) => resolve());
      scheduler.wake();
    }
    assert.equal(completed, 8); assert.ok(maximum <= 2); assert.deepEqual(errors, []);
  } finally { scheduler.stop(); }
});

test("invalid concurrency fails closed", () => {
  for (const concurrency of [0, -1, NaN, 1.5]) assert.throws(() => createScheduler({ concurrency }));
});
