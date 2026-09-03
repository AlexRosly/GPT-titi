const errorMiddleware = require("./error");
const auth = require("./auth");
const adminOnly = require("./adminOnly");
const authSocketMiddleware = require("./authSocket");
const upload = require("./upload");

module.exports = {
  errorMiddleware,
  auth,
  adminOnly,
  authSocketMiddleware,
  upload,
};
