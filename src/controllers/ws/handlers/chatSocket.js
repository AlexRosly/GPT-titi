// Legacy registration is intentionally unavailable. wsServer registers V2 only.
module.exports = () => { throw new Error("Use Chat Delivery V2"); };
