// This channel forwards balance invalidations only. Existing chat delivery keeps
// its own protocol; attaching a generic adapter would also change its broadcasts.
const createBalanceBus = async ({ io, transport = "local", redisUrl, namespace }) => {
  if (!["local", "redis"].includes(transport)) throw new Error("Invalid BALANCE_EVENTS_TRANSPORT");
  const deliver = (event) => {
    if (!event || typeof event.userId !== "string" || !Number.isSafeInteger(event.balanceVersion)) return;
    io.local.to(event.userId).emit("balance.updated", event);
  };
  if (transport === "local") return { publish: async (event) => deliver(event), close: async () => {} };
  if (!redisUrl || !namespace) throw new Error("Redis balance events require REDIS_URL and BALANCE_EVENTS_NAMESPACE");
  const Redis = require("ioredis");
  const publisher = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false,
    maxRetriesPerRequest: 1, connectionName: `${namespace}:publisher` });
  const subscriber = publisher.duplicate({ connectionName: `${namespace}:subscriber` });
  const channel = `${namespace}:balance-events`;
  const resync = () => io.local.emit("balance.sync", { reason: "redis_reconnected" });
  // Never log a Redis URL: it can contain credentials.
  publisher.on("error", () => {});
  subscriber.on("error", () => {});
  subscriber.on("message", (name, data) => {
    if (name !== channel) return;
    try { deliver(JSON.parse(data)); } catch { /* Ignore malformed internal messages. */ }
  });
  subscriber.on("ready", () => {
    // Subscribe on EVERY reconnect, then reread state for currently connected
    // browsers. Pub/Sub does not retain invalidations missed during an outage.
    subscriber.subscribe(channel).then(resync).catch(() => {});
  });
  try {
    await Promise.all([publisher.connect(), subscriber.connect()]);
    await subscriber.subscribe(channel);
  } catch (error) {
    publisher.disconnect(); subscriber.disconnect(); throw error;
  }
  return {
    async publish(event) {
      if (publisher.status !== "ready") throw new Error("Balance event transport unavailable");
      // Await publication, so a failed publish stays in the MongoDB outbox.
      await publisher.publish(channel, JSON.stringify(event));
    },
    async close() { publisher.disconnect(); subscriber.disconnect(); },
  };
};
module.exports = { createBalanceBus };
