const { User, Payment } = require("../../models");

const getUserBilling = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select(
      "email name appTokens status"
    );

    const payments = await Payment.find({ user: user._id });

    res.json({ code: 200, message: "success", user, payments });
  } catch (error) {
    console.error("Error in getUserBilling:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = getUserBilling;
