const positive = (name, fallback, max) => {
  const n = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`);
  return n;
};
module.exports = {
  enabled: () => process.env.PRIVATE_FILES_ENABLED === 'true',
  maxBytes: () => positive('FILES_MAX_BYTES', 25 * 1024 * 1024, 25 * 1024 * 1024),
  quotaBytes: () => positive('FILES_USER_BYTES', 250 * 1024 * 1024, 10 * 1024 ** 3),
  quotaCount: () => positive('FILES_USER_COUNT', 500, 10000),
  maxAttachments: 10,
  artifactBytes: 512 * 1024,
};
