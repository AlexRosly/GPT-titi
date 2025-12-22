const userRepository = require("../repositories/user.repository");
const tokenRepository = require("../repositories/token.repository");
const verifyGoogleToken = require("../utils/google");
const generateTokens = require("../utils/jwt");

exports.loginWithGoogle = async (token) => {
  const googleUser = await verifyGoogleToken(token);

  let user = await userRepository.findByGoogleId(googleUser.sub);

  if (!user) {
    user = await userRepository.create({
      googleId: googleUser.sub,
      email: googleUser.email,
      name: googleUser.name,
      avatar: googleUser.picture,
    });
  }

  const tokens = generateTokens(user);

  await tokenRepository.save({
    userId: user._id,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(Date.now() + 30 * 86400000),
  });

  return { user, ...tokens };
};
