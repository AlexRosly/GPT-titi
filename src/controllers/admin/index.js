const getUsers = require("./getUsers");
const getPayments = require("./getPayments");
const getUserBilling = require("./getUserBilling");
const blockUser = require("./blockUser");
const getModelAnalytics = require("./getModelAnalytics");
const getModels = require("./getModels");
const createModel = require("./createModel");
const changeUserRole = require("./changeUserRole");
const updateModel = require("./updateModel");

module.exports = {
  getUsers,
  getPayments,
  getUserBilling,
  blockUser,
  getModelAnalytics,
  getModels,
  createModel,
  changeUserRole,
  updateModel,
};
