const { TokenUsage } = require("../../models");

const tokenUsage = async (req, res) => {
  try {
    const userId = req.user._id;

    const usage = await TokenUsage.aggregate([
      { $match: { user: userId } },
      {
        $group: {
          _id: "$model",
          tokens: { $sum: "$totalTokens" },
          usd: { $sum: "$costUsd" },
        },
      },
    ]);

    const totalTokens = usage.reduce((s, u) => s + u.tokens, 0);
    const totalUsd = usage.reduce((s, u) => s + u.usd, 0);

    res.json({
      totalTokens,
      totalUsd,
      byModel: usage.map((u) => ({
        model: u._id,
        tokens: u.tokens,
      })),
    });
  } catch (error) {
    console.error("Error in controller tokenUsage:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = tokenUsage;
