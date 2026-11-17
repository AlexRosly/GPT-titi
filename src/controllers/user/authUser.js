// import User from "../models/User.js";
const { User } = require("../../models");
const { verifyGoogleToken } = require("../../services");
const { signAccessToken, signRefreshToken } = require("../../utils");
const tokenLedger = require("../../services/tokenLedger");
const { randomUUID } = require("node:crypto");
const { hashRefreshToken, setRefreshCookie } = require("../../utils/refreshSession");

const createUser = async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ error: "Missing idToken" });
  }

  try {
    const payload = await verifyGoogleToken(idToken);

    let user = await User.findOne({ email: payload.email });

    if (!user) {
      user = await tokenLedger.createAccount({
        googleId: payload.sub,
        email: payload.email,
        name: payload.name,
        avatar: payload.picture,
      });
    }
    // ⬇️ Минимальный payload внутри JWT
    const accessToken = signAccessToken({
      userId: user._id,
      role: user.role,
    });
    const refreshSessionId = randomUUID();
    const refreshToken = signRefreshToken({ userId: user._id, sid: refreshSessionId });
    user.refreshToken = await hashRefreshToken(refreshToken);
    user.refreshSessionId = refreshSessionId;
    user.previousRefreshToken = undefined;
    user.previousRefreshTokenExpiresAt = undefined;
    await user.save();
    setRefreshCookie(res, refreshToken);
    // ⬇️ Ответ клиенту
    res.json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        appTokens: user.appTokens,
        balanceVersion: user.balanceVersion || 0,
        role: user.role,
        dateClaimToken: user.dateClaimToken,
        nextDateClaimToken: user.nextDateClaimToken,
      },
      accessToken,
    });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: "Invalid Google token" });
  }
};

module.exports = createUser;
