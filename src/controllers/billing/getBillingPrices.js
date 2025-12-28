// controllers/billing/getBillingPrices.js
const { BillingPrice } = require("../../models");

const getBillingPrices = async (req, res) => {
  const prices = await BillingPrice.find({ enabled: true }).lean();
  res.json(prices);
};

module.exports = getBillingPrices;
