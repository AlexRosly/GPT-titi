const { ChatConversation, ChatMessage } = require('../../../models');
const File = require('../../../models/managedFile');
const store = require('../../../services/files/store');
const forkConversation = async (req, res) => {
  const { id: conversationId } = req.params;
  const { messageId } = req.body;
  const userId = req.user.id;
  if (!store.idOK(conversationId) || !store.idOK(messageId)) return res.status(400).json({ error: 'Valid conversation and message IDs required' });
  const newConversation = await store.transaction(async session => {
    const conversation = await ChatConversation.findOne({ _id: conversationId, user: userId }).session(session);
    const pivot = await ChatMessage.findOne({ _id: messageId, conversation: conversationId, user: userId, deleted: null }).session(session);
    if (!conversation || !pivot) return null;
    const messages = await ChatMessage.find({ conversation: conversationId, user: userId, deleted: null,
      $or: [{ createdAt: { $lt: pivot.createdAt } }, { createdAt: pivot.createdAt, _id: { $lte: pivot._id } }] }).sort({ createdAt: 1, _id: 1 }).session(session).lean();
    const ids = [...new Set(messages.flatMap(m => (m.attachments || []).filter(f => f.storage === 'private').map(f => f.fileId)))];
    // Serialize against explicit deletion/clear. Referenced files are not copied or billed twice.
    if (ids.length) await File.updateMany({ _id: { $in: ids }, user: userId }, { $set: { updatedAt: new Date() } }, { session });
    const [created] = await ChatConversation.create([{ user: userId, title: conversation.title + ' (fork)', modelId: conversation.modelId }], { session });
    await ChatMessage.insertMany(messages.map(m => ({ user: m.user, conversation: created._id, role: m.role,
      content: m.content, modelId: m.modelId, tokens: m.tokens, meta: m.meta, attachments: m.attachments,
      fileResult: m.fileResult, createdAt: m.createdAt })), { session });
    return created;
  });
  if (!newConversation) return res.status(404).json({ error: 'Conversation or message not found' });
  res.status(201).json({ conversationId: newConversation._id });
};
module.exports = forkConversation;
