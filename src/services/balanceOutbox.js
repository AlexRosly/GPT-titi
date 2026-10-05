const { randomUUID } = require("node:crypto");
const { BalanceOutbox } = require("../models");

let currentWorker = null;
const createOutboxWorker = ({ bus, pollMs = 1000 }) => {
  let running = false;
  let stopped = false;
  let timer;
  let inFlight = null;
  let wakePending = false;
  const drain = async () => {
    if (running || stopped) return inFlight;
    running = true;
    inFlight = (async () => {
      for (let count = 0; count < 100 && !stopped; count += 1) {
        const now = new Date();
        const leaseToken = randomUUID();
        const item = await BalanceOutbox.findOneAndUpdate({
          deliveredAt: null, nextAttemptAt: { $lte: now },
          $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
        }, { $set: { leaseToken, leaseUntil: new Date(now.getTime() + 30000) }, $inc: { attempts: 1 } },
        { new: true, sort: { createdAt: 1 } }).lean();
        if (!item) break;
        try {
          await bus.publish({
            userId: String(item.user), balanceVersion: item.balanceVersion,
            operationId: String(item.operation), reason: item.reason,
          });
          await BalanceOutbox.updateOne({ _id: item._id, leaseToken }, {
            $set: { deliveredAt: new Date(), leaseUntil: null, leaseToken: null },
          });
        } catch {
          await BalanceOutbox.updateOne({ _id: item._id, leaseToken }, { $set: {
            leaseUntil: null, leaseToken: null,
            nextAttemptAt: new Date(Date.now() + Math.min(30000, 500 * 2 ** Math.min(item.attempts, 6))),
          } });
        }
      }
    })().finally(() => {
      running = false;
      inFlight = null;
      if (wakePending && !stopped) { wakePending = false; setImmediate(wake); }
    });
    return inFlight;
  };
  const wake = () => {
    if (stopped) return;
    if (running) { wakePending = true; return; }
    void drain().catch(() => {});
  };
  return {
    drain,
    wake,
    start() { timer = setInterval(wake, pollMs); timer.unref(); wake(); },
    async stop() { stopped = true; clearInterval(timer); await inFlight?.catch(() => {}); },
  };
};
const startBalanceSync = async (io, options = {}) => {
  if (currentWorker) throw new Error("Balance sync is already running");
  const { createBalanceBus } = require("./balanceEvents");
  const bus = await createBalanceBus({ io,
    transport: process.env.BALANCE_EVENTS_TRANSPORT || "local",
    redisUrl: process.env.REDIS_URL,
    namespace: process.env.BALANCE_EVENTS_NAMESPACE,
    ...options,
  });
  const worker = createOutboxWorker({ bus });
  currentWorker = worker;
  worker.start();
  return async () => { await worker.stop(); await bus.close(); if (currentWorker === worker) currentWorker = null; };
};
module.exports = { createOutboxWorker, startBalanceSync, wake: () => currentWorker?.wake() };
