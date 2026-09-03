const { User } = require("../../models");

const claimToken = async (req, res) => {
  const userId = req.user._id;
  // const userId = "69496f6eba1cb5aab25860df";

  const now = new Date();
  const nextClaimDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const bonusToken = 10000;

  try {
    const user = await User.findById(userId).lean();
    if (user.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "User is not allowed",
      });
    }
    // ✅ атомарная операция
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: userId,
        $or: [
          { nextDateClaimToken: { $exists: false } },
          { nextDateClaimToken: null },
          { nextDateClaimToken: { $lte: now } },
        ],
      },
      {
        $inc: { appTokens: bonusToken },
        $set: {
          dateClaimToken: now,
          nextDateClaimToken: nextClaimDate,
        },
      },
      { new: true },
    );

    // ❗ если null — значит рано нажал
    if (!updatedUser) {
      return res.json({
        code: 200,
        success: false,
        message: "Too early to claim bonus",
        nextClaimDate: user?.nextDateClaimToken,
        appTokens: user.appTokens,
      });
    }

    return res.json({
      code: 200,
      success: true,
      message: "Bonus claimed successfully",
      appTokens: updatedUser.appTokens,
      nextClaimDate: updatedUser.nextDateClaimToken,
    });
  } catch (error) {
    console.error("Error in controller claimToken:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = claimToken;
