const path = require('node:path');
const { Worker } = require('node:worker_threads');
const config = require('./config');
const store = require('./store');
const textInput = require('./textInput');
const { fail } = require('./validation');
const FILE_BYTES = 5 * 1024 * 1024;
const TYPES = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const extension = file => path.extname(file.originalName || '').slice(1).toLowerCase();
const supported = file => Boolean(TYPES[extension(file)]) && ['application/octet-stream', TYPES[extension(file)]].includes(file.mimetype);
const enabled = model => config.enabled() && process.env.OFFICE_INPUT_ENABLED !== 'false' && model?.officeInputEnabled !== false;
// A per-process admission cap avoids unbounded parser workers under concurrent requests.
let active = 0;
const extract = async (buffer, ext) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > FILE_BYTES) throw fail('OFFICE_ATTACHMENT_TOO_LARGE', 413);
  if (!TYPES[ext]) throw fail('INVALID_OFFICE_DOCUMENT');
  if (active >= 2) throw fail('OFFICE_PROCESSING_BUSY', 503);
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'officeInputWorker.js'), { workerData: { buffer, ext }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Wait for termination before releasing the concurrency slot.
        worker.terminate().then(() => error ? reject(error) : resolve(value), reject);
      };
      const timer = setTimeout(() => finish(fail('OFFICE_PROCESSING_TIMEOUT', 413)), 10000);
      worker.once('message', result => finish(result.error ? fail(result.error, 422) : null, result.text));
      worker.once('error', () => finish(fail('INVALID_OFFICE_DOCUMENT', 422)));
      worker.once('exit', () => { if (!settled) finish(fail('INVALID_OFFICE_DOCUMENT', 422)); });
    });
  } finally { active--; }
};
const readPart = async (user, file, { session, state = textInput.budget(), model } = {}) => {
  if (!enabled(model)) throw fail('OFFICE_INPUT_DISABLED', 415);
  if (file.size > FILE_BYTES) throw fail('OFFICE_ATTACHMENT_TOO_LARGE', 413);
  const result = await store.read(user, String(file._id || file.fileId), { session });
  const text = await extract(result.buffer, extension(result.file));
  textInput.consume(state, Buffer.byteLength(text));
  const output = textInput.part(result.file, text);
  state.promptBytes += Buffer.byteLength(output.text);
  return output;
};
module.exports = { FILE_BYTES, TYPES, extension, supported, enabled, extract, readPart };
