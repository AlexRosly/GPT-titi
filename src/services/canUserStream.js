// services/billing.js
const { User } = require("../models");

const canUserStream = async (userId, estimatedCost) => {
  const user = await User.findById(userId).lean();

  return user.appTokens - estimatedCost >= -1000;
};

module.exports = canUserStream;
