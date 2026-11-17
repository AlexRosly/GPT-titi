const { User } = require("../../models");
const jwt = require("jsonwebtoken");
const {
  matchesRefreshToken, legacySessionId, clearRefreshCookie,
} = require("../../utils/refreshSession");

const logout = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const token = req.cookies?.refreshToken;
    let payload;
    if (token) {
      try {
        // Expired but correctly signed cookies can still revoke their session.
        payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET, {
          algorithms: ["HS256"], ignoreExpiration: true,
        });
      } catch { /* Missing / invalid sessions are already signed out. */ }
    }
    if (payload && typeof payload.userId === "string" && /^[a-f0-9]{24}$/i.test(payload.userId)) {
      const user = await User.findById(payload.userId);
      if (user?.refreshToken) {
        const sid = payload.sid || legacySessionId(token);
        if (user.refreshSessionId === sid) {
          // Revoke this login family, including a refresh from another tab.
          // An old cookie cannot revoke a newer Google login.
          await User.updateOne(
            { _id: user._id, refreshSessionId: sid },
            { $unset: { refreshToken: 1, refreshSessionId: 1, previousRefreshToken: 1, previousRefreshTokenExpiresAt: 1 } },
          );
        } else if (!user.refreshSessionId && await matchesRefreshToken(token, user.refreshToken)) {
          // Compatibility with sessions issued before this patch. Also match
          // their deterministic family if a concurrent refresh just upgraded it.
          await User.updateOne(
            { _id: user._id, $or: [
              { refreshToken: user.refreshToken, refreshSessionId: null },
              { refreshSessionId: sid },
            ] },
            { $unset: { refreshToken: 1, refreshSessionId: 1, previousRefreshToken: 1, previousRefreshTokenExpiresAt: 1 } },
          );
        }
      }
    }
    clearRefreshCookie(res);
    return res.json({ message: "Logged out" });
  } catch (error) {
    console.error("Logout failed:", error.message);
    // Keep the cookie on transient storage errors so the user can retry.
    return res.status(503).json({ error: "Could not log out. Please try again." });
  }
};

module.exports = logout;
