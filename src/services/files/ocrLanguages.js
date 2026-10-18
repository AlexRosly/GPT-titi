const { fail } = require('./validation');
// Tesseract's script models each cover multiple languages. This is script selection,
// not a claim to identify an exact language or every script on a mixed page.
const SCRIPTS = Object.freeze(['Arabic','Armenian','Bengali','Canadian_Aboriginal','Cherokee','Cyrillic','Devanagari','Ethiopic','Fraktur','Georgian','Greek','Gujarati','Gurmukhi','HanS','HanT','Hangul','Hebrew','Japanese','Kannada','Khmer','Lao','Latin','Malayalam','Myanmar','Oriya','Sinhala','Syriac','Tamil','Telugu','Thaana','Thai','Tibetan','Vietnamese']);
const mode = () => {
  const value = process.env.OCR_LANGUAGES || 'auto';
  if (value !== 'auto' && (value.length > 200 || value.split('+').some(v => ['auto','osd'].includes(v)) || !/^(?:script\/)?[A-Za-z][A-Za-z0-9_]{1,31}(?:\+(?:script\/)?[A-Za-z][A-Za-z0-9_]{1,31}){0,4}$/.test(value))) throw fail('OCR_UNAVAILABLE', 503);
  return value;
};
const listModels = output => new Set(output.split(/\r?\n/).map(v => v.trim()).filter(v => /^(?:script\/)?[A-Za-z][A-Za-z0-9_]*$/.test(v)));
const resolveScript = (name, available) => available.has('script/' + name) ? 'script/' + name : available.has(name) ? name : null;
const required = (setting, available) => setting === 'auto'
  ? ['osd', ...SCRIPTS.map(name => resolveScript(name, available) || 'script/' + name)]
  : setting.split('+');
const missing = (setting, available) => required(setting, available).filter(name => !available.has(name));
const parseOsd = output => {
  const script = /^Script:\s*([A-Za-z_]+)\s*$/m.exec(output)?.[1] || null;
  const value = Number(/^Script confidence:\s*([\d.]+)\s*$/m.exec(output)?.[1]);
  return { script, confidence: Number.isFinite(value) && value >= 0 ? value : null };
};
const aliases = { Han: ['HanS','HanT','Japanese'], Hiragana: ['Japanese'], Katakana: ['Japanese'], Korean: ['Hangul'], Bengali: ['Bengali'], Devanagari: ['Devanagari'] };
const select = (setting, available, detection) => {
  if (setting !== 'auto') {
    if (missing(setting, available).length) throw fail('OCR_UNAVAILABLE', 503);
    return { models: setting.split('+'), script: null, confidence: null, uncertain: false, mode: 'manual' };
  }
  const known = detection.script && (aliases[detection.script] || (SCRIPTS.includes(detection.script) ? [detection.script] : null));
  // Short/noisy samples can defeat OSD. A bounded fallback covers common scripts,
  // with an explicit warning; it is not advertised as universal language detection.
  const chosen = known ? [...known, 'Latin'] : ['Latin', 'Cyrillic', 'Arabic', 'HanS'];
  const models = [...new Set(chosen)].map(name => resolveScript(name, available));
  if (!available.has('osd') || models.some(name => !name)) throw fail('OCR_UNAVAILABLE', 503);
  return { models, script: known ? detection.script : null, confidence: detection.confidence,
    uncertain: !known || detection.confidence === null || detection.confidence < 2, mode: 'auto' };
};
const scriptPattern = {
  Cyrillic: /\p{Script=Cyrillic}/u, Greek: /\p{Script=Greek}/u, Arabic: /\p{Script=Arabic}/u,
  Hebrew: /\p{Script=Hebrew}/u, Korean: /\p{Script=Hangul}/u, Hangul: /\p{Script=Hangul}/u,
  Han: /\p{Script=Han}/u, Japanese: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  Devanagari: /\p{Script=Devanagari}/u,
};
const scriptQuality = (script, text) => {
  const letters = [...text].filter(c => /\p{L}/u.test(c));
  const pattern = scriptPattern[script];
  const matching = pattern ? letters.filter(c => pattern.test(c)).length : letters.length;
  return { matching, retryLayout: Boolean(pattern && letters.length >= 8 && matching / letters.length < 0.5) };
};
module.exports = { scriptQuality, SCRIPTS, mode, listModels, resolveScript, required, missing, parseOsd, select };
