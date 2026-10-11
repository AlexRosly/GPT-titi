const { getUsageSummary } = require("../../services/tokenHistory");
const { respond } = require("./tokenHistory");
// Financial usage must count ledger debits, never copied/forked chat messages.
module.exports = (req, res) => respond(req, res, () => getUsageSummary(req.user._id, req.query));
