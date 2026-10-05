// Stable application boundary. A future chain adapter implements these methods;
// controllers never select a ledger source or write User.appTokens themselves.
module.exports = require("./mongo");
