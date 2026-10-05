const ledger = require("../../services/tokenLedger");

const respond = async (req, res, read) => {
  res.set("Cache-Control", "no-store");
  try { return res.json(await read()); } catch (error) {
    if (error instanceof ledger.LedgerError) return res.status(error.status).json({ code: error.code, message: error.message });
    req.log?.error({ err: error }, "Balance request failed");
    return res.status(500).json({ code: "INTERNAL_ERROR", message: "Could not read token balance." });
  }
};
const getBalance = (req, res) => respond(req, res, () => ledger.getBalance(req.user._id));
const getTokenOperation = (req, res) => respond(req, res, () => ledger.getOperation(req.user._id, req.params.operationId));
module.exports = { getBalance, getTokenOperation };
