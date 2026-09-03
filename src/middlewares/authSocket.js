const jwt = require("jsonwebtoken");
const { User } = require("../models");

const authSocketMiddleware = async (socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.split(" ")[1];
    if (!token) {
      return next(new Error("Unauthorized: No token"));
    }

    // 🔐 проверка JWT (тот же что у тебя после Google login)
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // 👤 достаём юзера из БД (важно для токенов и статуса)
    const user = await User.findById(decoded.userId);
    if (!user) {
      return next(new Error("Unauthorized: User not found"));
    }

    if (user.status !== "active") {
      return next(new Error("User blocked"));
    }

    // 💾 вешаем на socket
    socket.user = {
      _id: user._id,
      role: user.role,
    };

    // 📦 кладём в комнату юзера (очень важно)
    socket.join(user._id.toString());

    next();
  } catch (error) {
    console.error("Socket auth error:", error.message);
    next(new Error("Unauthorized"));
  }
};

module.exports = authSocketMiddleware;
