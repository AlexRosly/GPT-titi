const { User } = require("../../models");
const { signAccessToken, signRefreshToken } = require("../../utils/auth");
const jwt = require("jsonwebtoken");
const {
  hashRefreshToken, matchesRefreshToken, legacySessionId, setRefreshCookie,
} = require("../../utils/refreshSession");

// Tabs share a cookie but may refresh concurrently. Briefly accept the previous
// token from this same login without rotating/writing another cookie. This also
// handles a losing CAS, while never reviving a revoked/replaced session.
const canReusePrevious = async (user, token, sid) => Boolean(
  user?.status === "active" && user.refreshToken && user.refreshSessionId === sid &&
  new Date(user.previousRefreshTokenExpiresAt).getTime() > Date.now() &&
  await matchesRefreshToken(token, user.previousRefreshToken)
);
const sendAccess = (res, user) => res.json({
  accessToken: signAccessToken({ userId: user._id, role: user.role }),
});

const refreshToken = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const token = req.cookies?.refreshToken;
    if (!token) return res.status(401).json({ error: "No refresh token" });
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET, { algorithms: ["HS256"] });
    const user = await User.findById(payload.userId);
    const sid = payload.sid || legacySessionId(token);
    if (!user || user.status !== "active" || !user.refreshToken) {
      return res.status(403).json({ error: "Invalid refresh token" });
    }
    if (user.refreshSessionId && user.refreshSessionId !== sid) {
      return res.status(403).json({ error: "Invalid refresh session" });
    }
    if (!(await matchesRefreshToken(token, user.refreshToken))) {
      if (await canReusePrevious(user, token, sid)) return sendAccess(res, user);
      return res.status(403).json({ error: "Invalid refresh token" });
    }
    const nextToken = signRefreshToken({ userId: user._id, sid });
    const nextHash = await hashRefreshToken(nextToken);
    // Compare-and-set: an in-flight refresh must never resurrect a signed-out
    // session or overwrite a more recent Google login / refresh.
    const result = await User.updateOne(
      { _id: user._id, status: "active", refreshToken: user.refreshToken },
      { $set: {
        refreshToken: nextHash, refreshSessionId: sid,
        previousRefreshToken: user.refreshToken,
        previousRefreshTokenExpiresAt: new Date(Date.now() + 10_000),
      } },
    );
    if (result.matchedCount !== 1) {
      const current = await User.findById(user._id);
      if (await canReusePrevious(current, token, sid)) return sendAccess(res, current);
      return res.status(403).json({ error: "Refresh session changed" });
    }
    setRefreshCookie(res, nextToken);
    return sendAccess(res, user);
  } catch {
    return res.status(403).json({ error: "Refresh token expired or invalid" });
  }
};

module.exports = refreshToken;
