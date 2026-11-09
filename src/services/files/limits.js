// Stage A: storage admission is deliberately separate from processing admission.
const path = require('node:path');
const config = require('./config');
const { textExtensions, fail } = require('./validation');
const MB = 1_000_000;
const categories = Object.freeze({
  document: { extensions: ['pdf', 'docx'], bytes: 25 * MB },
  text: { extensions: [...textExtensions].filter(x => !['csv', 'tsv'].includes(x)), bytes: MB },
  spreadsheet: { extensions: ['xlsx', 'csv', 'tsv'], bytes: 20 * MB },
  image: { extensions: ['png', 'jpg', 'jpeg', 'webp'], bytes: 15 * MB },
  archive: { extensions: ['zip'], bytes: 50 * MB },
  // Existing storage-only compatibility; no new PPTX reader is advertised.
  presentation: { extensions: ['pptx'], bytes: 25 * MB },
});
const uploadLimit = name => {
  const ext = path.extname(name).slice(1).toLowerCase();
  const type = Object.values(categories).find(c => c.extensions.includes(ext));
  if (!type) throw fail('UNSUPPORTED_FILE_TYPE', 415);
  return Math.min(type.bytes, config.uploadMaxBytes());
};
const effective = model => ({
  version: 1, profile: 'stage-a-storage', units: { MB: 1000000, GB: 1000000000 },
  storage: { maxBytes: config.quotaBytes(), maxCount: config.quotaCount(), unattachedTtlSeconds: null, retention: 'until_user_deletes', libraryVersion: 1 },
  upload: { maxBytes: config.uploadMaxBytes(), types: Object.fromEntries(Object.entries(categories).map(([k,v]) =>
    [k, { extensions: v.extensions, maxBytes: Math.min(v.bytes, config.uploadMaxBytes()) }])) },
  message: { maxAttachments: config.maxAttachments, maxBytes: config.maxBytes(),
    extractedTextBytes: require('./textInput').CONTEXT_BYTES },
  processing: {
    text: { enabled: require('./textInput').enabled(model), maxBytes: require('./textInput').FILE_BYTES },
    office: { enabled: require('./officeInput').enabled(model), maxBytes: require('./officeInput').FILE_BYTES },
    pdf: { enabled: require('./pdfInput').enabled(model), maxBytes: require('./pdfInput').FILE_BYTES },
    ocr: { enabled: require('./ocrInput').enabled(model), maxBytes: require('./preparationQueue').enabled() ? 25000000 : 5 * 1024 ** 2, maxOcrPages: require('./preparationQueue').enabled() ? 30 : 10, maxTextBytes: require('./preparationQueue').enabled() ? 1048576 : 65536, maxPdfPages: require('./preparationQueue').enabled() ? 100 : 50, imageMaxBytes: 5 * 1024 ** 2 },
    zip: { enabled: require('./zipInput').enabled(model), ...require('./zipCodec').LIMITS },
    pptx: { enabled: false },
  },
  preparation: { version: 2, pageCheckpoints: true, maxConcurrentPerUser: 1, maxConcurrentJobs: require('./ocrSlots').concurrency(), async: require('./preparationQueue').enabled(), kinds: ['ocr'], pollAfterMs: 2000, maxAttempts: 3 },
  uploadDoesNotGuaranteeProcessing: true,
});
module.exports = { uploadLimit, effective };
