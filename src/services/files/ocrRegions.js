// Optional regional verification. Confidence is a filter, not proof of correctness.
// No transliteration, language-specific word lists or replacement of primary text.
const { JOB_MS } = require('./ocrLimits');
const language = require('./ocrLanguages');
const enabled = () => process.env.OCR_REGIONS_ENABLED === 'true';
const profile = () => enabled() ? 'regions-3' : 'primary-3';
const MAX_REGIONS = 12;
const MAX_NOTES_BYTES = 8192;
const MAX_LAYOUT_RETRIES = 2; // Shared across pages in one worker job.
function candidates(lines = []) {
  return lines.map((line, index) => ({ ...line, line: index + 1, text: line.words.join(' ') }))
    .filter(line => [...line.text].filter(c => /\p{L}/u.test(c)).length >= 10 && line.right > line.left && line.bottom > line.top)
    // Stable priority: uncertain lines first, with their original line IDs retained.
    .sort((a, b) => a.confidence - b.confidence || a.line - b.line);
}
function budget(elapsed, spent, remainingPages = 0) {
  const ms = Math.min(8000 - spent, JOB_MS - elapsed - 5000 - remainingPages * 4000);
  return ms >= 500 ? ms : 0;
}
function selection(detection, available, primaryModels) {
  if (!detection.script || !Number.isFinite(detection.confidence) || detection.confidence <= 0) return null;
  const chosen = language.select('auto', available, detection);
  if (!chosen.script || chosen.models.every(model => primaryModels.includes(model))) return null;
  return { ...chosen, detectionUncertain: detection.confidence < 3 };
}
function scriptAgreement(script, text) {
  const aliases = { Han: 'Han', HanS: 'Han', HanT: 'Han', Korean: 'Hangul', Japanese: 'Han|Hiragana|Katakana', Fraktur: 'Latin', Vietnamese: 'Latin' };
  if (!language.SCRIPTS.includes(script) && !['Han','Korean'].includes(script)) return false;
  const names = (aliases[script] || script).split('|');
  const pattern = new RegExp(names.map(name=>'\\p{Script='+name+'}').join('|'),'u');
  const letters = [...text].filter(c=>/\p{L}/u.test(c));
  return letters.length >= 4 && letters.filter(c=>pattern.test(c)).length / letters.length >= 0.5;
}
function alternative(line, result, chosen) {
  const text = result.text.trim();
  if (!text || text === line.text || !Number.isFinite(result.confidence) || result.confidence < 70 || text.length > 2000 || /[\r\n]/.test(text)) return null;
  // Weak OSD is only a candidate. Require stronger independent recognition
  // and agreement with the candidate script before exposing an alternative.
  if (chosen.detectionUncertain && (!Number.isFinite(line.confidence) || result.confidence < 85 || result.confidence < line.confidence + 5 || !scriptAgreement(chosen.script, text))) return null;
  // Numeric disagreement is disclosed, never silently reconciled or guessed.
  const numbers = s => s.match(/\p{N}+(?:[.,:/-]\p{N}+)*/gu) || [];
  return { line: line.line, box: [line.left, line.top, line.right-line.left, line.bottom-line.top],
    ...(line.sourceLines ? {sourceLines:line.sourceLines,boundsStatus:line.boundsStatus} : {}),
    original: line.text, alternative: text, script: chosen.script, models: chosen.models,
    scriptDetectionUncertain: Boolean(chosen.detectionUncertain),
    numericAgreement: JSON.stringify(numbers(line.text)) === JSON.stringify(numbers(text)) };
}
// Retry only a plausible single-line reading rejected for confidence. PSM 13
// changes segmentation, never the raster, models, thresholds or primary text.
function verify(line, result, chosen, { state, remaining, run }) {
  const first = { result, value: alternative(line, result, chosen), psm: 7 };
  if (first.value) return first;
  const text = result.text.trim();
  const required = chosen.detectionUncertain ? Math.max(85, line.confidence + 5) : 70;
  if (!text || text === line.text || text.length > 2000 || /[\r\n]/.test(text) ||
      !Number.isFinite(result.confidence) || !Number.isFinite(required) ||
      result.confidence >= required || !scriptAgreement(chosen.script, text)) return first;
  if (state.attempts >= MAX_LAYOUT_RETRIES) return { ...first, retry: 'limit' };
  // Re-evaluate after PSM 7, not with its stale starting budget.
  const left = remaining();
  if (!Number.isFinite(left) || left < 500) return { ...first, retry: 'budget' };
  state.attempts++;
  const retried = run(13, Math.min(2000, left));
  const value = scriptAgreement(chosen.script, retried.text) ? alternative(line, retried, chosen) : null;
  if (value) { value.psm = 13; value.layoutFallback = true; }
  return { result: retried, value, psm: 13, retry: value ? 'accepted' : 'rejected' };
}
function note(values, incomplete) {
  let text = values.length ? '\n[OCR REGION ALTERNATIVES — unverified independent recognition of image regions; primary text above is unchanged. sourceLines identify primary OCR fragments; boxes use rendered-page pixels. A pixel-region and edgeCoverage are geometric checks, not proof of complete recognition; recognitionIncomplete=true means a crop edge may remain unread. Check the original; numericAgreement=false means numbers differ.]\n' + values.slice().sort((a,b)=>a.line-b.line).map(v=>JSON.stringify(v)).join('\n') : '';
  if (incomplete) text += '\n[OCR REGION CHECK INCOMPLETE: Limited sampling, uncertain script detection or time limits left regions unchecked. Short or omitted text and other scripts may still be misread.]';
  return text;
}
// Each part is one page or a document header. Optional notes must never turn
// an otherwise fitting primary document into OCR_TEXT_TOO_LARGE.
function fit(parts, limit) {
  const bytes = xs => xs.reduce((n,s)=>n+Buffer.byteLength(s),0);
  if (bytes(parts) <= limit) return { parts, omitted: false };
  const primary = parts.map(part => {
    const at = part.search(/\n\[OCR REGION (?:ALTERNATIVES|CHECK INCOMPLETE)/);
    return at < 0 ? part : part.slice(0,at)+'\n';
  });
  return { parts: primary, omitted: primary.some((part,i)=>part!==parts[i]) };
}
module.exports = { fit, enabled, profile, MAX_REGIONS, MAX_NOTES_BYTES, MAX_LAYOUT_RETRIES, candidates, budget, selection, alternative, verify, note };
