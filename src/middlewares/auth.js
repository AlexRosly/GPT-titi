// middleware/auth.js
const jwt = require("jsonwebtoken");
const { User } = require("../models");

const auth = async (req, res, next) => {
const header = req.headers.authorization;

if (!header || !header.startsWith("Bearer ")) {
return res.status(401).json({ error: "No token" });
}

const token = header.split(" ")[1];

try {
const payload = jwt.verify(token, process.env.JWT_SECRET);

// Поддержка обоих форматов payload:
// 1) { userId: "..." }
// 2) { userId: { userId: "...", role: "..." } } (из старых токенов)
const userId = payload?.userId?.userId || payload?.userId;

if (!userId) {
return res.status(401).json({ error: "Invalid token payload" });
}

const user = await User.findById(userId);
if (!user) return res.status(401).json({ error: "User not found" });

req.user = user;
next();
} catch (error) {
return res.status(401).json({ error: "Invalid token" });
}
};

module.exports = auth;
