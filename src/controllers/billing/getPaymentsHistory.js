const { Payment } = require("../../models");

//📌 Возвращает историю покупок пользователя
const getPaymentsHistory = async (req, res) => {
  try {
    const userId = req.user.id;

    const payments = await Payment.find({ user: userId })
      .sort({ createdAt: -1 })
      .select("-rawEvent");

    res.json(payments);
  } catch (error) {
    console.error("Error in controller getPaymentsHistory:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = getPaymentsHistory;
