const authService = require("../services/auth.service");

exports.googleAuth = async (req, res, next) => {
  try {
    const { credential } = req.body;
    const result = await authService.loginWithGoogle(credential);

    res.cookie("refreshToken", result.refreshToken, {
      httpOnly: true,
      secure: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.json({
      user: result.user,
      accessToken: result.accessToken,
    });
  } catch (e) {
    next(e);
  }
};

exports.me = (req, res) => {
  res.json(req.user);
};
