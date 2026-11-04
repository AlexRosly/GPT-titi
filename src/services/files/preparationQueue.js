const slots = require('./ocrSlots');
const crypto = require('node:crypto');
const Job = require('../../models/filePreparation');
const Models = require('../../models/chatModels');
const store = require('./store');
const ocr = require('./ocrInput');
const config = require('./config');
const { fail } = require('./validation');
const LEASE_MS = 90000, HEARTBEAT_MS = 10000, MAX_ATTEMPTS = 3;
const enabled = () => config.enabled() && process.env.FILE_PREPARATION_V2_ENABLED === 'true';
const retryable = code => ['OCR_PROCESSING_BUSY', 'OCR_PROCESSING_TIMEOUT', 'OCR_UNAVAILABLE', 'OCR_FAILED', 'FILE_QUOTA_EXCEEDED', 'PREPARATION_INTERRUPTED'].includes(code);
const errors = new Set(['PREPARATION_INTERRUPTED', 'OCR_PROCESSING_BUSY', 'OCR_PROCESSING_TIMEOUT', 'OCR_UNAVAILABLE', 'OCR_FAILED', 'OCR_NO_TEXT', 'OCR_PAGE_LIMIT', 'OCR_IMAGE_LIMIT', 'OCR_TEXT_TOO_LARGE', 'OCR_INVALID_IMAGE', 'INVALID_PDF_DOCUMENT', 'PDF_PASSWORD_PROTECTED', 'PDF_PAGE_LIMIT', 'FILE_QUOTA_EXCEEDED', 'FILE_NOT_FOUND', 'OCR_INPUT_DISABLED', 'MODEL_NOT_AVAILABLE', 'FILE_UNAVAILABLE', 'OCR_FILE_TOO_LARGE']);
const validModelId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
const authorize = async (user, id, modelId) => {
  const file = await store.owned(user, id);
  if (!validModelId(modelId)) throw fail('INVALID_ENVELOPE');
  const model = await Models.findOne({ modelId, enabled: true }).lean();
  if (!model) throw fail('MODEL_NOT_AVAILABLE', 404);
  if (ocr.supported(file) && !ocr.eligible(file, model)) throw fail('OCR_INPUT_DISABLED', 415);
  return { file, model };
};
const dto = (file, job) => {
  if (!ocr.supported(file)) return { status: 'not_required' };
  if (ocr.fresh(file)) return { status: 'ready', method: 'local_ocr', ocrPages: file.ocrCache.pages,
    textBytes: Buffer.byteLength(file.ocrCache.text), scripts: [...new Set((file.ocrCache.detections || []).map(d => d.script).filter(Boolean))],
    uncertain: (file.ocrCache.detections || []).some(d => d.uncertain === true) };
  if (!job) return { status: 'not_started' };
  const out = { status: job.status === 'ready' ? 'not_started' : job.status, method: 'local_ocr', attempts: job.attempts };
  if (file.ocrProgress?.checksum === file.checksum) {
    out.progress = { completedPages: file.ocrProgress.completed.length, totalPages: file.ocrProgress.totalPages, ocrPages: file.ocrProgress.manifest.filter(p=>p.ocr).length, failedPage: file.ocrProgress.failedPage };
  }
  if (['queued', 'running'].includes(out.status)) out.pollAfterMs = 2000;
  if (out.status === 'failed') { out.error = job.errorCode || 'OCR_FAILED'; out.retryable = job.attempts < MAX_ATTEMPTS && retryable(out.error); }
  if (out.status === 'cancelled') out.retryable = job.attempts < MAX_ATTEMPTS;
  return out;
};
const status = async (user, id, modelId) => {
  const { file } = await authorize(user, id, modelId);
  return dto(file, await Job.findOne({ user, file: file._id }).lean());
};
const enqueue = async (user, id, modelId, retry = false) => {
  const { file } = await authorize(user, id, modelId);
  if (!ocr.supported(file) || ocr.fresh(file)) return dto(file);
  if (file.size > (file.mimetype === 'application/pdf' ? 25000000 : 5 * 1024 ** 2)) throw fail('OCR_FILE_TOO_LARGE', 413);
  let job;
  try {
    job = await Job.findOneAndUpdate({ user, file: file._id }, { $setOnInsert: {
      user, file: file._id, checksum: file.checksum, modelId, status: 'queued', attempts: 0,
      expiresAt: new Date(Date.now() + 86400000),
    } }, { upsert: true, returnDocument: 'after' }).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    job = await Job.findOne({ user, file: file._id }).lean();
  }
  if (job?.status === 'ready') {
    // Cache was removed or its quality revision changed after this job completed.
    job = await Job.findOneAndUpdate({ _id: job._id, status: 'ready' },
      { $set: { status: 'queued', attempts: 0, checksum: file.checksum, modelId, expiresAt: new Date(Date.now() + 86400000) },
        $unset: { leaseToken: 1, leaseUntil: 1, errorCode: 1 } }, { returnDocument: 'after' }).lean()
      || await Job.findById(job._id).lean();
  }
  if (retry && job && (job.status === 'cancelled' || (job.status === 'failed' && retryable(job.errorCode)))) {
    job = await Job.findOneAndUpdate({ _id: job._id, status: job.status, attempts: { $lt: MAX_ATTEMPTS } },
      { $set: { status: 'queued', modelId, expiresAt: new Date(Date.now() + 86400000) }, $unset: { leaseToken: 1, leaseUntil: 1, errorCode: 1 } },
      { returnDocument: 'after' }).lean() || await Job.findById(job._id).lean();
  }
  return dto(file, job);
};
const cancel = async (user, id) => {
  await store.owned(user, id);
  await Job.updateOne({ user, file: id, status: { $in: ['queued', 'running'] } },
    { $set: { status: 'cancelled' }, $unset: { leaseToken: 1, leaseUntil: 1 } });
};
// One local worker; the Mongo lease fences claims across PM2 instances.
// Active native OCR is additionally capped by ocrProcess. Old synchronous API remains supported.
const runOnce = async () => {
  if (!enabled()) return false;
  const now = new Date();
  await Job.updateMany({ status: { $in: ['queued', 'running'] }, attempts: { $gte: MAX_ATTEMPTS },
    $or: [{ leaseUntil: { $lte: now } }, { leaseUntil: null }] },
    { $set: { status: 'failed', errorCode: 'PREPARATION_INTERRUPTED' }, $unset: { leaseToken: 1, leaseUntil: 1 } });
  const token = crypto.randomUUID();
  const job = await Job.findOneAndUpdate({ expiresAt: { $gt: now }, attempts: { $lt: MAX_ATTEMPTS },
    $or: [{ status: 'queued' }, { status: 'running', leaseUntil: { $lte: now } }] },
    { $set: { status: 'running', leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) }, $inc: { attempts: 1 }, $unset: { errorCode: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }).lean();
  if (!job) return false;
  let resourceKeys;
  try { await slots.init(); resourceKeys = await slots.acquire(job.user,token); }
  catch(error) {
    await Job.updateOne({_id:job._id,status:'running',leaseToken:token},{$set:{status:'queued'},$inc:{attempts:-1},$unset:{leaseToken:1,leaseUntil:1}});
    if(error.fileError !== 'OCR_PROCESSING_BUSY') throw error;
    return false;
  }
  const controller = new AbortController();
  const fence = { _id: job._id, status: 'running', leaseToken: token };
  let checking = false;
  const verify = async (session) => {
    await slots.verify(resourceKeys,token,session);
    if (!enabled()) throw fail('OCR_INPUT_DISABLED', 415);
    const { file, model } = await authorize(job.user, String(job.file), job.modelId);
    if (file.checksum !== job.checksum) throw fail('FILE_UNAVAILABLE', 503);
    const result = await Job.updateOne({ ...fence, leaseUntil: { $gt: new Date() } }, { $set: { leaseUntil: new Date(Date.now() + LEASE_MS) } }, session ? { session } : {});
    if (!result.matchedCount) throw fail('PREPARATION_INTERRUPTED', 409);
    return model;
  };
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { await verify(); } catch { controller.abort(); } finally { checking = false; }
  }, HEARTBEAT_MS);
  timer.unref();
  try {
    const model = await verify();
    await ocr.prepare(job.user, String(job.file), model, { signal: controller.signal, beforeCommit: verify, paged: true });
    controller.signal.throwIfAborted();
    await verify();
    await Job.updateOne(fence, { $set: { status: 'ready' }, $unset: { leaseToken: 1, leaseUntil: 1, errorCode: 1 } });
  } catch (error) {
    const code = controller.signal.aborted ? 'PREPARATION_INTERRUPTED' : errors.has(error.fileError) ? error.fileError : 'OCR_FAILED';
    await Job.updateOne(fence, { $set: { status: 'failed', errorCode: code }, $unset: { leaseToken: 1, leaseUntil: 1 } });
  } finally { clearInterval(timer); controller.abort(); await slots.release(resourceKeys,token); }
  return true;
};
let running = false, timer;
const start = () => {
  if (timer) return;
  timer = setInterval(async () => {
    if (running || !enabled()) return;
    running = true;
    try { await runOnce(); } catch (error) {
      require('../../utils/logger').error({ code: error.fileError || 'PREPARATION_WORKER_ERROR' }, 'File preparation worker failed');
    } finally { running = false; }
  }, 2000);
  timer.unref();
};
const stop = () => { clearInterval(timer); timer = null; };
module.exports = { enabled, enqueue, status, cancel, runOnce, start, stop, dto, retryable, LEASE_MS, MAX_ATTEMPTS };
