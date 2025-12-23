const { TokenUsage } = require("../../models");

const getUsageHistory = async (req, res) => {
  try {
    const days = Number(req.query.days || 7);
    const from = new Date(Date.now() - days * 86400000);

    const data = await TokenUsage.aggregate([
      {
        $match: {
          user: req.user._id,
          createdAt: { $gte: from },
        },
      },
      {
        $group: {
          _id: {
            day: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
          },
          tokens: { $sum: "$totalTokens" },
        },
      },
      { $sort: { "_id.day": 1 } },
    ]);

    res.json(data);
  } catch {
    console.error("Error in controller getUsageHistory:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = getUsageHistory;
