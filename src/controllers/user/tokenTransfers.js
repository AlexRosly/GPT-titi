const { checkRecipient, transferTokens, TokenTransferError } = require("../../services/tokenTransfers");

const respondWithError = (req, res, error) => {
  if (error instanceof TokenTransferError) {
    return res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
      ...error.details,
    });
  }
  req.log?.error({ err: error }, "Token transfer request failed");
  return res.status(500).json({ success: false, code: "INTERNAL_ERROR", message: "Internal server error." });
};

const getTransferRecipient = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const result = await checkRecipient({ userId: req.user._id, email: req.query.email });
    return res.json(result);
  } catch (error) {
    return respondWithError(req, res, error);
  }
};

const sendTokens = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const result = await transferTokens({
      userId: req.user._id,
      email: req.body?.email,
      amount: req.body?.amount,
      clientTransferId: req.body?.clientTransferId,
    });
    return res.json(result);
  } catch (error) {
    return respondWithError(req, res, error);
  }
};

module.exports = { getTransferRecipient, sendTokens };
