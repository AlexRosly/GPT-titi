const { ChatConversation, ChatMessage, ChatTurn } = require('../../models');
const File = require('../../models/managedFile');
const store = require('./store');
const { fail } = require('./validation');

// Explicit opt-in only: legacy clients and Archive keep library files.
module.exports = async function deleteConversationFiles(user, id, deleteFiles, session) {
  if (!store.idOK(String(id))) throw fail('CONVERSATION_NOT_FOUND', 404);
  const run = async session => {
    // Fence concurrent acceptance, which writes this same conversation in its transaction.
    const chat = await ChatConversation.findOneAndUpdate(
      { _id: id, user }, { $set: { archived: true, updatedAt: new Date() } }, { session, new: true });
    if (!chat) throw fail('CONVERSATION_NOT_FOUND', 404);
    if (!deleteFiles) return { success: true, deletedFiles: 0 };
    if (await ChatTurn.exists({ user, conversation: id, status: { $in: ['queued', 'processing'] } }).session(session))
      throw fail('CHAT_BUSY_STOP_BEFORE_DELETE', 409);
    const ids = new Set();
    const add = refs => { for (const ref of refs || []) if (store.idOK(ref.fileId)) ids.add(ref.fileId); };
    // Include soft-cleared messages: clearing a chat never unlinks library files.
    const messages = await ChatMessage.find({ user, conversation: id }).select('attachments').session(session).lean();
    for (const message of messages) add(message.attachments);
    const turns = await ChatTurn.find({ user, conversation: id }).select('files').session(session).lean();
    for (const turn of turns) add(turn.files);
    const files = await File.find({ user, _id: { $in: [...ids] }, status: 'ready', retention: { $ne: 'temporary' } })
      .select('_id').session(session).lean();
    for (const file of files) await store.remove(user, String(file._id), session);
    return { success: true, deletedFiles: files.length };
  };
  return session ? run(session) : store.transaction(run);
};
