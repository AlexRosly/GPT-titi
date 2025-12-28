// controllers/billing/getPrices.js
const { Price } = require("../../models");

const getPrices = async (req, res) => {
  const prices = await Price.find({ enabled: true })
    .sort({ sortOrder: 1 })
    .select("-_id stripePriceId label appTokens amount currency");

  res.json(prices);
};

module.exports = getPrices;
