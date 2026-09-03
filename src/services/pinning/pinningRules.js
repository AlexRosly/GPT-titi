const CONVERSATION_SORT = Object.freeze({
  pinnedAt: -1,
  lastMessageAt: -1,
  _id: -1,
});

const PROJECT_SORT = Object.freeze({
  pinnedAt: -1,
  lastMessageAt: -1,
  updatedAt: -1,
  _id: -1,
});

const buildPinnedAtExpression = (pinned) =>
  pinned
    ? {
        $ifNull: ["$pinnedAt", "$$NOW"],
      }
    : null;

const resolvePinnedAt = ({ currentPinnedAt, pinned, now }) => {
  if (pinned) {
    return currentPinnedAt ?? now;
  }

  return null;
};

module.exports = {
  CONVERSATION_SORT,
  PROJECT_SORT,
  buildPinnedAtExpression,
  resolvePinnedAt,
};
