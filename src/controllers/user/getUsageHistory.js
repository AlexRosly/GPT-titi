const { getUsageDays } = require("../../services/tokenHistory");
const { respond } = require("./tokenHistory");
module.exports = (req, res) => respond(req, res, () => getUsageDays(req.user._id, req.query));
