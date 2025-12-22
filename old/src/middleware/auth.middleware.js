const jwt = require("jsonwebtoken");
const { config } = require("../config/env");
const User = require("../models/user.model");

module.exports = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Unauthorized" });

    const decoded = jwt.verify(token, config.JWT_SECRET);
    req.user = await User.findById(decoded.id).lean();

    next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid token" });
  }
};
