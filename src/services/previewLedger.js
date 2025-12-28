// services/previewLedger.js
const previewLedger = new Map();

/*
 key: userId:modelId
 value: reservedAppTokens
*/

const getKey = (userId, modelId) => `${userId}:${modelId}`;

module.exports = {
  get(userId, modelId) {
    return previewLedger.get(getKey(userId, modelId)) || 0;
  },

  set(userId, modelId, value) {
    previewLedger.set(getKey(userId, modelId), value);
  },

  clear(userId, modelId) {
    previewLedger.delete(getKey(userId, modelId));
  },
};
