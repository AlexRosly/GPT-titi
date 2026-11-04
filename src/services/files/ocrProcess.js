// No shell, URLs or user-controlled paths. One isolated Linux process group per job.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fail } = require('./validation');
const limits = require('./ocrLimits');
let active = 0;
let lastCleanup = 0;
const cleanupTemporary = async () => {
  if (Date.now() - lastCleanup < 3600000) return;
  lastCleanup = Date.now();
  for (const name of await fs.readdir(os.tmpdir())) {
    if (!/^gptiti-ocr-[A-Za-z0-9]{6}$/.test(name)) continue;
    const location = path.join(os.tmpdir(), name);
    try {
      const info = await fs.lstat(location);
      if (info.isDirectory() && info.uid === process.getuid() && Date.now() - info.mtimeMs > 3600000) await fs.rm(location, { recursive: true, force: true });
    } catch { /* A concurrent process may have already removed it. */ }
  }
};
const languages = require('./ocrLanguages').mode;
const extract = async (buffer, kind, { signal, page } = {}) => {
  signal?.throwIfAborted();
  if (process.platform !== 'linux') throw fail('OCR_UNAVAILABLE', 503);
  if (!['pdf', 'image'].includes(kind) || !Buffer.isBuffer(buffer) || !buffer.length || buffer.length > (page !== undefined ? 25000000 : 5 * 1024 * 1024)) throw fail('OCR_FILE_TOO_LARGE', 413);
  if (page !== undefined && (kind !== 'pdf' || !(page === 'inspect' || Number.isInteger(page) && page >= 1 && page <= 100))) throw fail('INVALID_PDF_DOCUMENT');
  const lang = languages();
  if (active >= 2) throw fail('OCR_PROCESSING_BUSY', 503);
  active++;
  let dir;
  try {
    await cleanupTemporary();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gptiti-ocr-')); // 0700, random; never served by HTTP.
    await fs.writeFile(path.join(dir, 'input'), buffer, { mode: 0o600 });
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn('prlimit', ['--as=2147483648', `--cpu=${limits.CPU_SECONDS}`, '--core=0', '--', process.execPath, '--max-old-space-size=192', '--disable-wasm-trap-handler', '--v8-pool-size=1', path.join(__dirname, 'ocrProcessWorker.js'), dir, kind, lang, ...(page === undefined ? [] : [String(page)])], {
        detached: true, stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, OMP_THREAD_LIMIT: '1', MALLOC_ARENA_MAX: '2', RAYON_NUM_THREADS: '1', UV_THREADPOOL_SIZE: '1', ...(process.env.OCR_TESSDATA_DIR ? { TESSDATA_PREFIX: process.env.OCR_TESSDATA_DIR } : {}) },
      });
      let output = '', bytes = 0, error;
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const abort = () => { error = fail('PREPARATION_INTERRUPTED', 409); kill(); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => { error = fail('OCR_PROCESSING_TIMEOUT', 413); kill(); }, limits.JOB_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 512 * 1024) { error = fail('OCR_TEXT_TOO_LARGE', 413); kill(); }
        else output += chunk.toString('utf8');
      });
      child.on('error', () => { error = fail('OCR_UNAVAILABLE', 503); });
      child.on('close', code => {
        signal?.removeEventListener('abort', abort);
        clearTimeout(timer); kill(); // Also terminate surviving descendants on failure.
        if (error) return reject(error);
        if (code !== 0) return reject(fail('OCR_FAILED', 422));
        try {
          const result = JSON.parse(output);
          const allowed = new Set(['OCR_UNAVAILABLE', 'OCR_NO_TEXT', 'OCR_PAGE_LIMIT', 'OCR_IMAGE_LIMIT', 'OCR_TEXT_TOO_LARGE', 'OCR_PROCESSING_TIMEOUT', 'OCR_INVALID_IMAGE', 'INVALID_PDF_DOCUMENT', 'PDF_PASSWORD_PROTECTED', 'PDF_PAGE_LIMIT']);
          if (result.error) return reject(fail(allowed.has(result.error) ? result.error : 'OCR_FAILED', 422));
          if (page === 'inspect') {
            if (!Number.isInteger(result.totalPages) || result.totalPages < 1 || result.totalPages > 100 || !Array.isArray(result.manifest) || result.manifest.length !== result.totalPages || result.manifest.some((p,i) => p.page !== i+1 || typeof p.ocr !== 'boolean') || result.manifest.filter(p => p.ocr).length > 30) throw new Error();
            return resolve(result);
          }
          if (typeof result.text !== 'string' || Buffer.byteLength(result.text) > 65536 || !Number.isInteger(result.pages) || result.pages < 0 || result.pages > 10) throw new Error();
          if (!Array.isArray(result.detections) || result.detections.length !== result.pages || result.detections.some(d => !Number.isInteger(d.page) || d.page < 1 || d.page > (page === undefined ? 50 : 100) || !Array.isArray(d.models) || d.models.length > 4)) throw new Error();
          resolve({ text: result.text, pages: result.pages, languages: lang, detections: result.detections });
        } catch { reject(fail('OCR_FAILED', 422)); }
      });
    });
  } finally {
    try { if (dir) await fs.rm(dir, { recursive: true, force: true }); } finally { active--; }
  }
};
module.exports = { extract, languages };
