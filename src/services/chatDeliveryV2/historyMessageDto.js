const historyMessageDto = (message) => {
  if (!message) return message;
  const plain = typeof message.toObject === "function" ? message.toObject() : { ...message };
  return {
    ...plain,
    id: plain._id?.toString?.() || plain.id || null,
    turnId: plain.turnId ?? null,
    clientMessageId: plain.clientMessageId ?? null,
    attempt: plain.attempt ?? null,
  };
};

module.exports = historyMessageDto;
