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
  storage: { maxBytes: config.quotaBytes(), maxCount: config.quotaCount(), unattachedTtlSeconds: 86400 },
  upload: { maxBytes: config.uploadMaxBytes(), types: Object.fromEntries(Object.entries(categories).map(([k,v]) =>
    [k, { extensions: v.extensions, maxBytes: Math.min(v.bytes, config.uploadMaxBytes()) }])) },
  message: { maxAttachments: config.maxAttachments, maxBytes: config.maxBytes(),
    extractedTextBytes: require('./textInput').CONTEXT_BYTES },
  processing: {
    text: { enabled: require('./textInput').enabled(model), maxBytes: require('./textInput').FILE_BYTES },
    office: { enabled: require('./officeInput').enabled(model), maxBytes: require('./officeInput').FILE_BYTES },
    pdf: { enabled: require('./pdfInput').enabled(model), maxBytes: require('./pdfInput').FILE_BYTES },
    ocr: { enabled: require('./ocrInput').enabled(model), maxBytes: 5 * 1024 ** 2, maxOcrPages: 10, maxTextBytes: 65536 },
    zip: { enabled: require('./zipInput').enabled(model), ...require('./zipCodec').LIMITS },
    pptx: { enabled: false },
  },
  preparation: { version: 1, async: require('./preparationQueue').enabled(), kinds: ['ocr'], pollAfterMs: 2000, maxAttempts: 3 },
  uploadDoesNotGuaranteeProcessing: true,
});
module.exports = { uploadLimit, effective };
