const { ChatMessage } = require('../../models');
const store = require('./store');
const textInput = require('./textInput');
const inputReader = require('./inputReader');
// Freeze the existing 20-message window at acceptance: 19 prior messages + current.
const prior = (user, conversation, session) => ChatMessage.find({ user, conversation, deleted: null })
  .sort({ createdAt: -1, _id: -1 }).limit(19).session(session).lean();
const forTurn = async (turn, session) => {
  if (Array.isArray(turn.contextMessageIds)) {
    const records = await ChatMessage.find({ user: turn.user, conversation: turn.conversation, deleted: null,
      _id: { $in: [...turn.contextMessageIds, turn.userMessage] } }).session(session || null).lean();
    const byId = new Map(records.map(m => [String(m._id), m]));
    return [...turn.contextMessageIds, turn.userMessage].map(id => byId.get(String(id))).filter(Boolean);
  }
  return (await ChatMessage.find({ user: turn.user, conversation: turn.conversation, deleted: null,
    createdAt: { $lte: turn.createdAt || new Date() } }).sort({ createdAt: -1, _id: -1 }).limit(20).session(session || null).lean()).reverse();
};
const estimate = async (user, history, model, session) => {
  const state = textInput.budget();
  for (const message of history) {
    if (message.role !== 'user') continue;
    for (const attachment of message.attachments || []) {
      if (attachment.storage !== 'private') continue;
      let file;
      try { file = await store.owned(user, String(attachment.fileId), { session }); }
      catch (error) { if (error.fileError === 'FILE_NOT_FOUND') continue; throw error; }
      if (inputReader.supported(file, model)) await inputReader.readPart(user, file, { model, session, state });
    }
  }
  return state;
};
module.exports = { prior, forTurn, estimate };
