// Transport suites replace the provider worker. Keep their fake execution
// behind wake(), the same boundary used by the production handlers.
const installTestWake = (worker, ChatTurn) => {
  const original = worker.wake;
  worker.wake = () => {
    setImmediate(async () => {
      const queued = await ChatTurn.find({ status: "queued" }).lean();
      for (const turn of queued) {
        const claimed = await worker.claimTurn(turn.turnId);
        if (claimed) await worker.processTurn(claimed);
      }
    });
  };
  return () => { worker.wake = original; };
};
module.exports = { installTestWake };
