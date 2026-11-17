const { createHash, createHmac } = require("node:crypto");
const bcrypt = require("bcrypt");

// Hash the entire JWT before bcrypt (which only considers the first 72 bytes).
// Keep legacy hashes readable so deployment does not sign existing users out.
const PREFIX = "sha256:";
const digest = (token) => createHash("sha256").update(token).digest("hex");
const hashRefreshToken = async (token) => PREFIX + await bcrypt.hash(digest(token), 10);
const matchesRefreshToken = async (token, stored) => {
  if (typeof stored !== "string" || !stored) return false;
  return stored.startsWith(PREFIX)
    ? bcrypt.compare(digest(token), stored.slice(PREFIX.length))
    : bcrypt.compare(token, stored);
};

// A legacy token's first rotation gets a stable family ID. Its original cookie
// can still log out that family if another tab rotated it concurrently.
const legacySessionId = (token) => createHmac("sha256", process.env.JWT_REFRESH_SECRET)
  .update(token).digest("hex");

const refreshCookieOptions = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
});
const setRefreshCookie = (res, token) => res.cookie("refreshToken", token, {
  ...refreshCookieOptions,
  maxAge: 30 * 24 * 60 * 60 * 1000,
});
const clearRefreshCookie = (res) => res.clearCookie("refreshToken", refreshCookieOptions);

module.exports = {
  hashRefreshToken, matchesRefreshToken, legacySessionId,
  setRefreshCookie, clearRefreshCookie,
};
