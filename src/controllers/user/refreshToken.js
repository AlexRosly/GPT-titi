const { User } = require("../../models");
const { signAccessToken } = require("../../utils");
const jwt = require("jsonwebtoken");

const refreshToken = async (req, res) => {
  try {
    const refreshToken = req.cookies.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({ error: "No refresh token" });
    }

    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    const user = await User.findById(payload.userId);

    if (
      !user ||
      user.status !== "active" ||
      user.refreshToken !== refreshToken
    ) {
      return res.status(403).json({ error: "Invalid refresh token" });
    }

    const accessToken = signAccessToken({
      userId: user._id,
      role: user.role,
    });

    res.json({ accessToken });
  } catch (err) {
    return res.status(403).json({ error: "Refresh token expired" });
  }
};

module.exports = refreshToken;
