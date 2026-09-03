// middleware/auth.js
const jwt = require("jsonwebtoken");
const { User } = require("../models");

const auth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: "No token" });

    const token = header.split(" ")[1];
    // 🔐 проверка JWT (тот же что у тебя после Google login)
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // req.user = jwt.verify(token, process.env.JWT_SECRET);
    // 👤 достаём юзера из БД (важно для токенов и статуса)
    // const user = await User.findById(payload.userId);
    const user = await User.findById(decoded.userId);

    if (!user) return res.status(401).json({ error: "User not found" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

module.exports = auth;
