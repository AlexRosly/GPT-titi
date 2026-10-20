// Keep the whole job below the frontend's 65-second prepare request timeout.
// Admission/history preflight still has its separate 45-second wait budget.
const JOB_MS = 55000;
const CPU_SECONDS = 50;
const RECOGNITION_MS = 20000;
const RENDER_DPI = 300;
const MAX_RENDER_SIDE = 3600;
const renderSide = viewport => {
  const longest = Math.max(viewport.width, viewport.height);
  if (!Number.isFinite(longest) || longest <= 0) throw require('./validation').fail('INVALID_PDF_DOCUMENT');
  return Math.max(1, Math.min(MAX_RENDER_SIDE, Math.ceil(longest)));
};
module.exports = { JOB_MS, CPU_SECONDS, RECOGNITION_MS, RENDER_DPI, MAX_RENDER_SIDE, renderSide };
