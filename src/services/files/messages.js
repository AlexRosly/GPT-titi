const File = require('../../models/managedFile');
const ChatMessage = require('../../models/chatMessage');
const store = require('./store');
const config = require('./config');
const { fail } = require('./validation');
const privateFile = (f) => f?.storage === 'private';
const resolve = async (user, files, session) => {
  if (!Array.isArray(files) || files.length > config.maxAttachments) throw fail('INVALID_ATTACHMENTS');
  const out = [];
  let totalBytes = 0;
  for (const f of files) {
    const id = f?.fileId || f?.id || f?._id;
    if ([f?.fileId, f?.id, f?._id].filter(Boolean).some(value => value !== id)) throw fail("INVALID_ATTACHMENTS");
    if (!id || typeof id !== 'string') throw fail('FILE_ID_REQUIRED');
    const file = await store.owned(user, id, { session });
    totalBytes += file.size;
    if (totalBytes > config.maxBytes()) throw fail("ATTACHMENTS_TOO_LARGE", 413);
    // This release stores documents but only sends raster images to the model.
    // Do not charge a request while silently ignoring its document attachment.
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) throw fail('DOCUMENT_PROCESSING_NOT_ENABLED', 415);
    await File.updateOne({ _id: file._id, status: 'ready' }, { $set: { expiresAt: null } }, { session });
    out.push({ ...store.dto(file), expiresAt: null, storage: 'private' });
  }
  return out;
};
const hydrate = async (user, messages) => {
  const ids = [...new Set(messages.flatMap(m => (m.attachments || []).filter(privateFile).map(f => String(f.fileId))))];
  if (!ids.length) return messages;
  const records = await File.find({ _id: { $in: ids }, user }).lean();
  const map = new Map(records.map(f => [String(f._id), f]));
  return messages.map(m => ({ ...(m.toObject ? m.toObject() : m),
    ...(m.fileResult?.fileId && map.get(String(m.fileResult.fileId))?.status !== 'ready'
      ? { fileResult: { ...m.fileResult, status: 'deleted' } } : {}), attachments: (m.attachments || []).map(f => {
    if (!privateFile(f)) return f;
    const current = map.get(String(f.fileId));
    if (!current || current.status !== 'ready' || (current.expiresAt && current.expiresAt <= new Date())) {
      return { fileId: String(f.fileId), originalName: f.originalName, status: 'deleted', storage: 'private', url: null, downloadUrl: null, previewUrl: null };
    }
    return { ...store.dto(current), storage: 'private' };
  }) }));
};
const providerContent = async (user, text, files = []) => {
  const content = text ? [{ type: 'text', text }] : [];
  for (const f of files) {
    if (privateFile(f)) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.mimetype)) continue;
      // Read private bytes ourselves. No public URL or bearer token goes to OpenAI.
      try {
        const { file, buffer } = await store.read(user, String(f.fileId));
        content.push({ type: 'image_url', image_url: { url: `data:${file.mimetype};base64,${buffer.toString('base64')}` } });
      } catch (error) {
        if (error.fileError !== 'FILE_NOT_FOUND') throw error;
        content.push({ type: 'text', text: '[A previously attached image was deleted and is no longer available.]' });
      }
    } else if (f?.mimetype?.startsWith('image/') && f.url && !f.deletedAt && (!f.expiresAt || new Date(f.expiresAt) > new Date())) {
      content.push({ type: 'image_url', image_url: { url: f.url } });
    }
  }
  return content;
};
const removeUnreferenced = async (user, ids, session) => {
  for (const id of [...new Set(ids.map(String))]) {
    const reference = await ChatMessage.exists({ user, deleted: null, 'attachments.fileId': id }).session(session);
    if (!reference) await store.remove(user, id, session);
  }
};
module.exports = { resolve, hydrate, providerContent, privateFile, removeUnreferenced };
