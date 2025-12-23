const { User } = require("../../models");

const getUsers = async (req, res) => {
  try {
    const users = await User.find().select(
      "email name appTokens role status createdAt"
    );

    res.json({ code: 200, message: "success", users });
  } catch (error) {
    console.error("Error in getUsers:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = getUsers;
