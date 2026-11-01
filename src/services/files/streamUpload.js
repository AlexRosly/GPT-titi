// Private, unlinked spool: bounded RAM, no public path, OS closes bytes on process exit.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const multer = require('multer');
const config = require('./config');
const { fail, safeName, textExtensions, validateUpload } = require('./validation');
const { uploadLimit } = require('./limits');
const spool = async (input, name, signal) => {
  safeName(name);
  const maxBytes = uploadLimit(name);
  const ext = path.extname(name).slice(1).toLowerCase();
  const decoder = textExtensions.has(ext) ? new TextDecoder('utf-8', { fatal: true }) : null;
  const location = path.join(os.tmpdir(), `gptiti-upload-${crypto.randomUUID()}`);
  let handle;
  try {
    handle = await fs.open(location, 'wx+', 0o600);
    await fs.unlink(location); // Remove name BEFORE receiving any user bytes.
    let size = 0, prefix = Buffer.alloc(0);
    const hash = crypto.createHash('sha256');
    const check = new Transform({ transform(chunk, encoding, done) {
      try {
        size += chunk.length;
        if (size > maxBytes) throw fail('FILE_TOO_LARGE', 413);
        if (prefix.length < 12) prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)]);
        if (decoder) {
          if (chunk.includes(0)) throw fail('INVALID_TEXT');
          try { decoder.decode(chunk, { stream: true }); } catch { throw fail('INVALID_UTF8'); }
        }
        hash.update(chunk); done(null, chunk);
      } catch (error) { done(error); }
    } });
    const sink = new Writable({ write(chunk, encoding, done) {
      (async () => {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw fail('FILE_UPLOAD_UNAVAILABLE', 503);
          offset += bytesWritten;
        }
      })().then(() => done(), done);
    } });
    await pipeline(input, check, sink, { signal });
    if (!size) throw fail('EMPTY_FILE');
    if (decoder) { try { decoder.decode(); } catch { throw fail('INVALID_UTF8'); } }
    // Text was checked incrementally; binary signatures use only their prefix.
    const metadata = validateUpload({ originalname: name, buffer: decoder ? Buffer.from('validated') : prefix });
    return { ...metadata, size, checksum: hash.digest('hex'), handle, maxBytes };
  } catch (error) {
    if (handle) { await handle.close().catch(() => {}); await fs.unlink(location).catch(() => {}); }
    throw error;
  }
};
const storage = {
  _handleFile(req, file, done) {
    const name = require('./uploadName')(file.originalname);
    spool(file.stream, name, req.uploadSignal).then(result => {
      req.uploadHandles.add(result.handle);
      done(null, result);
    }, done);
  },
  _removeFile(req, file, done) {
    if (!file.handle) return done();
    file.handle.close().then(() => { req.uploadHandles.delete(file.handle); done(); }, done);
  },
};
let active = 0;
const receive = (handler) => async (req, res, next) => {
  if (active >= config.uploadSlots()) return res.status(503).json({ error: 'FILE_UPLOAD_BUSY', retryable: true });
  active++;
  const controller = new AbortController();
  req.uploadSignal = controller.signal;
  req.uploadHandles = new Set();
  const abort = () => controller.abort();
  req.once('aborted', abort); res.once('close', abort);
  const timer = setTimeout(() => { abort(); req.destroy(); }, 120000);
  timer.unref();
  try {
    const upload = multer({ storage, limits: { fileSize: config.uploadMaxBytes(), files: 1, fields: 0, parts: 2 } });
    await new Promise((resolve, reject) => upload.single('file')(req, res, err => err ? reject(err) : resolve()));
    controller.signal.throwIfAborted();
    if (!req.file) throw fail('FILE_REQUIRED');
    await handler(req, res);
  } catch (error) {
    if (res.destroyed || res.headersSent) return;
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'INVALID_UPLOAD' });
    if (error.fileError) return res.status(error.status).json({ error: error.fileError });
    next(error);
  } finally {
    clearTimeout(timer); req.removeListener('aborted', abort); res.removeListener('close', abort);
    await Promise.allSettled([...req.uploadHandles].map(handle => handle.close()));
    active--;
  }
};
module.exports = { spool, receive };
