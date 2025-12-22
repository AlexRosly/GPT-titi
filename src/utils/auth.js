const jwt = require("jsonwebtoken");

// const signAccessToken = (user) => {
//   return jwt.sign(
//     { userId: user._id, role: user.role },
//     process.env.JWT_SECRET,
//     { expiresIn: "15m" }
//   );
// };

// const signRefreshToken = (user) => {
//   return jwt.sign({ userId: user._id }, process.env.JWT_REFRESH_SECRET, {
//     expiresIn: "30d",
//   });
// };

const signAccessToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "15m" });

const signRefreshToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: "30d" });

module.exports = { signAccessToken, signRefreshToken };
