const { fail } = require('./validation');
const { JOB_MS } = require('./ocrLimits');

// TSV is a tab-separated OCR protocol, not CSV: quotes are literal glyphs.
// Keep Tesseract's block/paragraph/line and word order (including RTL).
function parseTsv(tsv) {
  if (!tsv.startsWith('level\tpage_num\t')) throw fail('OCR_FAILED');
  const lines = [];
  let current, weight = 0, confidenceSum = 0, lowWeight = 0, uncertainNumber = false;
  let minX = Infinity, maxX = 0;
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const fields = row.split('\t');
    if (fields[0] !== '5') continue;
    if (fields.length !== 12) throw fail('OCR_FAILED');
    const [left, top, width, height, confidence] = fields.slice(6, 11).map(Number);
    if (![left, top, width, height, confidence].every(Number.isFinite) || width < 0 || height < 0 || confidence < -1 || confidence > 100) throw fail('OCR_FAILED');
    const word = fields[11].replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (!word) continue;
    const key = fields.slice(1, 5).join(':');
    if (current?.key !== key) { current = { key, paragraph: fields.slice(1, 4).join(':'), words: [], left, right: left + width, top, bottom: top + height }; lines.push(current); }
    current.top = Math.min(current.top, top); current.bottom = Math.max(current.bottom, top + height);
    current.words.push(word); current.left = Math.min(current.left, left); current.right = Math.max(current.right, left + width);
    minX = Math.min(minX, left); maxX = Math.max(maxX, left + width);
    weight += word.length; confidenceSum += Math.max(0, confidence) * word.length;
    if (confidence < 60) lowWeight += word.length;
    if (/\p{N}/u.test(word) && confidence < 75) uncertainNumber = true;
  }
  const text = lines.map((line, i) => (i && line.paragraph !== lines[i - 1].paragraph ? '\n' : '') + line.words.join(' ')).join('\n');
  if (Buffer.byteLength(text) > 65536) throw fail('OCR_TEXT_TOO_LARGE');
  const confidence = weight ? confidenceSum / weight : 0;
  const lowFraction = weight ? lowWeight / weight : 0;
  const wide = lines.filter(line => line.right - line.left >= (maxX - minX) * 0.65).length;
  const singleColumn = lines.length >= 4 && wide / lines.length >= 0.4;
  let fragmentation = 0;
  if (singleColumn) for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    // Only diagnose; never reorder words geometrically (would break RTL/columns).
    if (b.bottom < a.top || (a.key !== b.key && overlap > Math.min(a.bottom-a.top, b.bottom-b.top) * 0.5 && (a.right <= b.left || b.right <= a.left))) fragmentation++;
  }
  return { text, characters: weight, confidence, lowFraction,
    singleColumn, fragmentation,
    uncertain: weight > 0 && (confidence < 85 || lowFraction > 0.12 || uncertainNumber) };
}
function preferAlternative(primary, alternative) {
  // Confidence is a heuristic, never proof of correctness; don't choose a
  // short, high-confidence fragment over a substantially fuller result.
  if (primary.singleColumn && primary.fragmentation > 0 &&
      alternative.fragmentation < primary.fragmentation &&
      alternative.characters >= primary.characters * 0.95 && alternative.confidence >= primary.confidence - 1)
    return true;
  return alternative.characters >= primary.characters * 0.9 && alternative.confidence >= primary.confidence + 2;
}
function retryBudget(elapsedMs, remainingPages, retries) {
  if (retries >= 2) return 0;
  // Leave room for every remaining page before spending time on an optional
  // repeat. Text-layer pages may make this conservative, never less bounded.
  const reserve = Math.max(25000, remainingPages * 18000);
  const budget = Math.min(8000, JOB_MS - elapsedMs - reserve);
  return budget >= 2000 ? budget : 0;
}
module.exports = { parseTsv, preferAlternative, retryBudget };
