const { User } = require("../../models");

const blockUser = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, {
      status: "blocked",
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error in blockUser:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = blockUser;
