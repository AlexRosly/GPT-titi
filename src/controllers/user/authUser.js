// import User from "../models/User.js";
const { User } = require("../../models");
const { verifyGoogleToken } = require("../../services");
const { signAccessToken, signRefreshToken } = require("../../utils");
const bcrypt = require("bcrypt");

const createUser = async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ error: "Missing idToken" });
  }

  try {
    const payload = await verifyGoogleToken(idToken);

    let user = await User.findOne({ email: payload.email });

    if (!user) {
      user = await User.create({
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
    const refreshToken = signRefreshToken({ userId: user._id });
    // ⬇️ Храним refresh token (лучше хэш, но можно так на старте)
    // user.refreshToken = refreshToken;
    user.refreshToken = await bcrypt.hash(refreshToken, 10);
    await user.save();
    // ⬇️ Устанавливаем cookie
    // const isProd = process.env.NODE_ENV === "production";
    // res.cookie("refreshToken", refreshToken, {
    //   httpOnly: true,
    //   secure: process.env.NODE_ENV === "production",
    //   sameSite: "strict",
    //   maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней
    // });
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true, // true только в prod
      sameSite: "none",
      // path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    // ⬇️ Ответ клиенту
    res.json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        appTokens: user.appTokens,
        role: user.role,
      },
      accessToken,
    });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: "Invalid Google token" });
  }
};

module.exports = createUser;
