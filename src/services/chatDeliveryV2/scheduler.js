// One scheduler owns every provider launch in this process. Reserve a slot
// before awaiting a claim; wake-ups and the timer can never overbook it.
const createScheduler = ({ claim, process, recover, concurrency, pollMs = 2000, onError = console.error }) => {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Invalid CHAT_V2_WORKERS");
  let active = 0;
  let draining = false;
  let stopped = false;
  const wake = () => { void drain().catch(onError); };
  const drain = async () => {
    if (draining || stopped) return;
    draining = true;
    try {
      await recover();
      while (!stopped && active < concurrency) {
        active += 1;
        let claimed;
        try { claimed = await claim(); } catch (error) { active -= 1; throw error; }
        if (!claimed) { active -= 1; break; }
        Promise.resolve().then(() => process(claimed)).catch(onError).finally(() => { active -= 1; wake(); });
      }
    } finally { draining = false; }
  };
  const timer = setInterval(wake, pollMs);
  timer.unref();
  return { wake, stop: () => { stopped = true; clearInterval(timer); } };
};
module.exports = { createScheduler };
