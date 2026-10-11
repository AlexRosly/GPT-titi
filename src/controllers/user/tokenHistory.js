const history = require("../../services/tokenHistory");
const { HistoryError } = require("../../services/tokenHistoryQuery");
const respond = async (req, res, read) => {
  res.set("Cache-Control", "no-store");
  try { return res.json(await read()); } catch (error) {
    if (error instanceof HistoryError) return res.status(400).json({ code: error.code, message: error.message });
    req.log?.error({ err: error }, "Token history request failed");
    return res.status(500).json({ code: "INTERNAL_ERROR", message: "Could not read token history." });
  }
};
const getTokenHistory = (req, res) => respond(req, res, () => history.getHistory(req.user._id, req.query));
const getTokenHistorySummary = (req, res) => respond(req, res, () => history.getSummary(req.user._id, req.query));
const getTokenHistoryDayCharges = (req, res) => respond(req, res, () => history.getDayCharges(req.user._id, req.params.day, req.query));
module.exports = { respond, getTokenHistory, getTokenHistorySummary, getTokenHistoryDayCharges };
