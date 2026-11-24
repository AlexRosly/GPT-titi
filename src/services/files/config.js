const positive = (name, fallback, max) => {
  const n = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`);
  return n;
};
const FILE_BYTES = 50_000_000;
const maxBytes = () => positive('FILES_MAX_BYTES', FILE_BYTES, FILE_BYTES);
module.exports = {
  FILE_BYTES,
  enabled: () => process.env.PRIVATE_FILES_ENABLED === 'true',
  maxBytes,
  generatedMaxBytes: () => Math.min(maxBytes(), 25 * 1024 ** 2),
  quotaBytes: () => positive('FILES_USER_BYTES', 2_000_000_000, 10 * 1024 ** 3),
  uploadMaxBytes: () => positive('FILES_UPLOAD_MAX_BYTES', FILE_BYTES, FILE_BYTES),
  uploadSlots: () => positive('FILES_UPLOAD_SLOTS', 2, 4),
  maxAttachments: 10,
  artifactBytes: 512 * 1024,
};
