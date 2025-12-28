// utils/tokenEstimate.js
const estimateTokens = (text) => {
  return Math.ceil(text.length / 4); // ~4 chars per token
};

module.exports = estimateTokens;
