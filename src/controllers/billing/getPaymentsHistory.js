const { Payment } = require("../../models");

//📌 Возвращает историю покупок пользователя
const getPaymentsHistory = async (req, res) => {
  const userId = req.user.id;

  const payments = await Payment.find({ user: userId })
    .sort({ createdAt: -1 })
    .select("-rawEvent");

  res.json(payments);
};

module.exports = getPaymentsHistory;
