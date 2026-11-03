const historyMessageDto = (message) => {
  if (!message) return message;
  const plain = typeof message.toObject === "function" ? message.toObject() : { ...message };
  return {
    ...plain,
    // tokens is provider output usage, not the amount debited from the user.
    billing: plain.role === "assistant" && Number.isFinite(plain.meta?.appTokens) && plain.meta.appTokens >= 0
      ? { appTokensSpent: plain.meta.appTokens }
      : null,
    id: plain._id?.toString?.() || plain.id || null,
    turnId: plain.turnId ?? null,
    clientMessageId: plain.clientMessageId ?? null,
    attempt: plain.attempt ?? null,
  };
};

module.exports = historyMessageDto;
