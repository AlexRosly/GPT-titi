const { Payment } = require("../../models");

const getPayments = async (req, res) => {
  try {
    const payments = await Payment.find()
      .populate("user", "email name")
      .sort({ createdAt: -1 });

    res.json({ code: 200, message: "success", payments });
  } catch (error) {
    console.error("Error in getPayments:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = getPayments;
