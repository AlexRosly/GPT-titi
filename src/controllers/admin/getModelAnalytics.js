const { TokenUsage } = require("../../models");

const getModelAnalytics = async (req, res) => {
  try {
    const data = await TokenUsage.aggregate([
      {
        $group: {
          _id: "$model",
          totalTokens: { $sum: "$totalTokens" },
          totalUsd: { $sum: "$costUsd" },
        },
      },
      { $sort: { totalUsd: -1 } },
    ]);

    res.json(data);
  } catch (error) {
    console.error("Error in controller tokenUsage:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = getModelAnalytics;
