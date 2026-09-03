const { Price } = require("../../models");

const getBillingPrices = async (req, res) => {
  try {
    const prices = await Price.find({ enabled: true })
      .sort({ sortOrder: 1, _id: 1 })
      .select("-_id stripePriceId label appTokens amount currency")
      .lean();

    return res.status(200).json(prices);
  } catch (error) {
    console.error("Error in controller getBillingPrices:", error);
    return res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = getBillingPrices;
