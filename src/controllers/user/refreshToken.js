// const { User } = require("../../models");
// const { signAccessToken } = require("../../utils");
// const jwt = require("jsonwebtoken");

// const refreshToken = async (req, res) => {
//   try {
//     const refreshToken = req.cookies.refreshToken;

//     if (!refreshToken) {
//       return res.status(401).json({ error: "No refresh token" });
//     }

//     const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

//     const user = await User.findById(payload.userId);

//     if (
//       !user ||
//       user.status !== "active" ||
//       user.refreshToken !== refreshToken
//     ) {
//       return res.status(403).json({ error: "Invalid refresh token" });
//     }

//     const accessToken = signAccessToken({
//       userId: user._id,
//       role: user.role,
//     });

//     res.json({ accessToken });
//   } catch (err) {
//     return res.status(403).json({ error: "Refresh token expired" });
//   }
// };

// module.exports = refreshToken;
const { User } = require("../../models");
const { signAccessToken } = require("../../utils");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const refreshToken = async (req, res) => {
  try {
    const refreshTokenFromCookie = req.cookies.refreshToken;

    if (!refreshTokenFromCookie) {
      return res.status(401).json({ error: "No refresh token" });
    }

    // 1️⃣ Проверяем JWT refresh token
    const payload = jwt.verify(
      refreshTokenFromCookie,
      process.env.JWT_REFRESH_SECRET
    );

    // 2️⃣ Ищем пользователя
    const user = await User.findById(payload.userId);

    if (!user || user.status !== "active") {
      return res.status(403).json({ error: "Invalid refresh token" });
    }

    // 3️⃣ Сравниваем refreshToken (bcrypt)
    const isValid = await bcrypt.compare(
      refreshTokenFromCookie,
      user.refreshToken
    );

    if (!isValid) {
      return res.status(403).json({ error: "Invalid refresh token" });
    }

    // 4️⃣ Генерируем новый access token
    const accessToken = signAccessToken({
      userId: user._id,
      role: user.role,
    });

    // 5️⃣ ROTATION: создаём новый refresh token
    const newRefreshToken = jwt.sign(
      { userId: user._id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "30d" }
    );

    // 6️⃣ Сохраняем ХЕШ нового refresh token
    user.refreshToken = await bcrypt.hash(newRefreshToken, 10);
    await user.save();

    // 7️⃣ Обновляем cookie
    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: true, // true в prod (https)
      sameSite: "none",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return res.json({ accessToken });
  } catch (err) {
    return res.status(403).json({ error: "Refresh token expired" });
  }
};

module.exports = refreshToken;
