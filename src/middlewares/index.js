const errorMiddleware = require("./error");
const auth = require("./auth");
const adminOnly = require("./adminOnly");

module.exports = {
  errorMiddleware,
  auth,
  adminOnly,
};
