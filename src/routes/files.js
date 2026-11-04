const express = require('express');
const { auth } = require('../middlewares');
const config = require('../services/files/config');
const store = require('../services/files/store');
const router = express.Router();
const handle = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) {
  if (err.fileError) return res.status(err.status).json({ error: err.fileError });
  next(err);
} };
router.use(auth, (req, res, next) => {
  if (!config.enabled()) return res.status(404).json({ error: 'FILES_DISABLED' });
  if (req.user.status !== 'active') return res.status(403).json({ error: 'ACCOUNT_INACTIVE' });
  next();
});
router.use(require('express-rate-limit').rateLimit({ windowMs: 60000, limit: 120,
  keyGenerator: req => String(req.user._id), standardHeaders: true, legacyHeaders: false }));
// Register before /:id: authenticated effective limits, never a model-name table.
router.get('/limits', handle(async (req, res) => {
  let model;
  if (req.query.modelId !== undefined) {
    if (typeof req.query.modelId !== 'string' || !req.query.modelId || req.query.modelId.length > 200) return res.status(400).json({ error: 'INVALID_ENVELOPE' });
    model = await require('../models/chatModels').findOne({ modelId: req.query.modelId, enabled: true }).lean();
    if (!model) return res.status(404).json({ error: 'MODEL_NOT_AVAILABLE' });
  }
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.json(require('../services/files/limits').effective(model));
}));
router.post('/', require('../services/files/streamUpload').receive(async (req, res) => {
  const file = await store.createUpload({ user: req.user._id, upload: req.file, signal: req.uploadSignal });
  res.status(201).json({ success: true, file: store.dto(file) });
}));
// Opt-in asynchronous protocol. Existing /prepare contract stays unchanged.
const queue = require('../services/files/preparationQueue');
const asyncEnabled = (req, res, next) => queue.enabled() ? next() : res.status(404).json({ error: 'PREPARATION_DISABLED' });
router.post('/:id/preparation', asyncEnabled, express.json({ limit: '1kb' }), handle(async (req, res) => {
  if (!req.body || Object.keys(req.body).some(k => !['modelId', 'retry'].includes(k)) ||
      (req.body.retry !== undefined && typeof req.body.retry !== 'boolean')) return res.status(400).json({ error: 'INVALID_ENVELOPE' });
  const processing = await queue.enqueue(req.user._id, req.params.id, req.body.modelId, req.body.retry === true);
  res.set('Cache-Control', 'private, no-store');
  res.status(['queued', 'running'].includes(processing.status) ? 202 : 200).json({ success: true, processing });
}));
router.get('/:id/preparation', asyncEnabled, handle(async (req, res) => {
  const processing = await queue.status(req.user._id, req.params.id, req.query.modelId);
  res.set('Cache-Control', 'private, no-store').json({ success: true, processing });
}));
router.delete('/:id/preparation', asyncEnabled, handle(async (req, res) => {
  await queue.cancel(req.user._id, req.params.id);
  res.status(204).end();
}));
// Frontend prepares attachments before chat:send, avoiding the short V2 ACK timeout.
router.post('/:id/prepare', express.json({ limit: '1kb' }), handle(async (req, res) => {
  const file = await store.owned(req.user._id, req.params.id);
  if (!req.body || typeof req.body.modelId !== 'string' || !req.body.modelId || req.body.modelId.length > 200 || Object.keys(req.body).some(k => k !== 'modelId')) {
    return res.status(400).json({ error: 'INVALID_ENVELOPE' });
  }
  const model = await require('../models/chatModels').findOne({ modelId: req.body.modelId, enabled: true }).lean();
  if (!model) return res.status(404).json({ error: 'MODEL_NOT_AVAILABLE' });
  const ocr = require('../services/files/ocrInput');
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  const zip = require('../services/files/zipInput');
  if (zip.supported(file)) {
    try {
      await zip.waitPrepare(req.user._id, req.params.id, model);
      const ready = await store.owned(req.user._id, req.params.id);
      return res.json({ success: true, processing: { status: 'ready', method: 'zip',
        ocrPages: ready.zipCache.ocrPages, textBytes: Buffer.byteLength(ready.zipCache.text),
        scripts: [], uncertain: ready.zipCache.uncertain, entries: ready.zipCache.entries.length } });
    } catch (error) {
      if (!error.fileError) throw error;
      const detail = require('../services/chatDeliveryV2/protocol').errorFor(error.fileError);
      return res.status(error.status || 422).json({error: detail.code, message: detail.message, retryable: detail.retryable});
    }
  }
  if (!ocr.eligible(file, model)) return res.json({ success: true, processing: { status: 'not_required' } });
  try {
    await ocr.prepare(req.user._id, req.params.id, model);
    const ready = await store.owned(req.user._id, req.params.id);
    return res.json({ success: true, processing: { status: 'ready', method: 'local_ocr', ocrPages: ready.ocrCache.pages, textBytes: Buffer.byteLength(ready.ocrCache.text), scripts: [...new Set((ready.ocrCache.detections || []).map(d => d.script).filter(Boolean))], uncertain: (ready.ocrCache.detections || []).some(d => d.uncertain) } });
  } catch (error) {
    if (!error.fileError) throw error;
    const detail = require('../services/chatDeliveryV2/protocol').errorFor(error.fileError);
    return res.status(error.status || 422).json({ error: detail.code, message: detail.message, retryable: detail.retryable });
  }
}));
router.get('/', handle(async (req, res) => {
  const File = require('../models/managedFile');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const filter = { user: req.user._id, status: 'ready' };
  if (req.query.before) {
    if (!store.idOK(req.query.before)) return res.status(400).json({ error: 'INVALID_CURSOR' });
    filter._id = { $lt: req.query.before };
  }
  const files = await File.find(filter).sort({ _id: -1 }).limit(limit).lean();
  const quota = await require('../models/fileQuota').findById(req.user._id).lean();
  res.json({ files: files.map(store.dto), nextCursor: files.length === limit ? String(files.at(-1)._id) : null,
    quota: { bytes: quota?.bytes || 0, count: quota?.count || 0, maxBytes: config.quotaBytes(), maxCount: config.quotaCount() } });
}));
router.get('/:id', handle(async (req, res) => res.json({ file: store.dto(await store.owned(req.user._id, req.params.id, { includeDeleted: true })) })));
router.get('/:id/download', handle(async (req, res) => {
  const { file, buffer } = await store.read(req.user._id, req.params.id);
  res.set({ 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store', 'Content-Security-Policy': "sandbox; default-src 'none'",
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.originalName).replace(/'/g, '%27')}` });
  res.send(buffer);
}));
// Read an existing cache only: never start OCR, call a provider or create a charge.
router.get('/:id/ocr', handle(async (req, res) => {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'" });
  const file = await store.owned(req.user._id, req.params.id);
  const ocr = require('../services/files/ocrInput');
  if (!ocr.supported(file)) return res.status(415).json({ error: 'OCR_UNSUPPORTED' });
  if (!ocr.cached(file)) return res.status(409).json({ error: 'OCR_NOT_READY' });
  const cache = file.ocrCache;
  if (req.query.download === '1') {
    const name = file.originalName + '.ocr.txt';
    res.set({ 'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="recognized-text.txt"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}` });
    return res.send(Buffer.from(cache.text, 'utf8'));
  }
  res.json({ kind: 'ocr', text: cache.text, version: cache.version,
    textBytes: Buffer.byteLength(cache.text), ocrPages: cache.pages,
    uncertain: (cache.detections || []).some(d => d.uncertain === true),
    legacy: cache.version !== 3 || cache.qualityRevision !== 3 });
}));
router.get('/:id/preview', handle(async (req, res) => {
  const { file, buffer } = await store.read(req.user._id, req.params.id);
  if (['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.mimetype)) {
    const bytes = file.mimetype === 'image/svg+xml'
      ? Buffer.from(require('../services/files/artifacts').sanitizeSvg(buffer.toString('utf8'))) : buffer;
    res.set({ 'Content-Type': file.mimetype, 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'none'" });
    return res.send(bytes);
  }
  if (require('../services/files/zipInput').supported(file) && require('../services/files/zipInput').cached(file)) {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.json({ kind: 'archive', entries: file.zipCache.entries, truncated: false });
  }
  if (file.source === 'generated' && file.generatedPreview) {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.json(file.generatedPreview);
  }
  const text = file.mimetype.startsWith('text/') || ['application/json', 'image/svg+xml'].includes(file.mimetype);
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.json({ kind: text ? 'text' : 'unavailable', mimetype: file.mimetype,
    text: text ? buffer.subarray(0, 65536).toString('utf8') : null, truncated: text && buffer.length > 65536 });
}));
router.delete('/:id', handle(async (req, res) => { await store.remove(req.user._id, req.params.id); res.status(204).end(); }));
module.exports = router;
