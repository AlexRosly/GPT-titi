const tokenLedger = require("../../services/tokenLedger");

const claimToken = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const result = await tokenLedger.claimBonus({ userId: req.user._id });
    return res.json({ ...result, code: 200,
      message: result.success ? "Bonus claimed successfully" : "Too early to claim bonus" });
  } catch (error) {
    if (error instanceof tokenLedger.LedgerError) {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    }
    console.error("Error in controller claimToken:", error);
    return res.status(500).json({ status: 500, message: "Internal server error" });
  }
};

module.exports = claimToken;
