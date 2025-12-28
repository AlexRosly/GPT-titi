// controllers/chat/chatPreview.js
const { estimateCost } = require("../../utils");
const { User, ChatModels } = require("../../models");

const NEGATIVE_LIMIT = -1000;

const chatPreview = async (req, res) => {
  const { modelId, estimatedTokens } = req.body;
  const userId = req.user.id;

  if (!modelId || !estimatedTokens) {
    return res.status(400).json({
      error: "modelId and estimatedTokens required",
    });
  }

  const model = await ChatModels.findOne({ modelId, enabled: true });
  if (!model) {
    return res.status(400).json({ error: "Model not available" });
  }

  let estimate;
  try {
    estimate = await estimateCost(modelId, estimatedTokens);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const user = await User.findById(userId);
  if (!user) return res.status(401).json({ error: "User not found" });

  const projectedBalance = user.appTokens - estimate.appTokens;

  if (projectedBalance < NEGATIVE_LIMIT) {
    return res.status(402).json({
      error: "Insufficient balance",
      required: estimate.appTokens,
      balance: user.appTokens,
      limit: NEGATIVE_LIMIT,
    });
  }

  res.json({
    ok: true,
    estimate,
    balanceAfter: projectedBalance,
  });
};

module.exports = chatPreview;
