// A Latin-only second recognition is evidence, not permission to transliterate.
// Keep the primary text verbatim, especially real Cyrillic inventory numbers.
const pattern = /^([\p{L}]{2,24})([-–])([0-9]{1,12})$/u;
const MAX_WORDS = 12, ROW_HEIGHT = 128;
const candidates = words => words.filter(w => pattern.test(w.text) && /\p{Script=Cyrillic}/u.test(w.text));
const alternatives = (originals, recognized) => originals.flatMap((original, index) => {
  const row = recognized.words.filter(w => Math.floor((w.top + w.height / 2) / ROW_HEIGHT) === index);
  if (row.length !== 1) return [];
  const candidate = row[0];
  const before = pattern.exec(original.text), after = /^([A-Z]{2,24})([-–])([0-9]{1,12})$/.exec(candidate.text);
  if (!before || !after || before[1].length !== after[1].length || before[3] !== after[3] ||
      candidate.confidence < 80 || candidate.text === original.text) return [];
  return [{ original: original.text, latin: candidate.text }];
});
const note = values => values.length
  ? '\n[OCR IDENTIFIER ALTERNATIVES — unverified Latin-only recognition; primary text above is unchanged. Check the original before using either spelling.]\n' +
    values.map(v => JSON.stringify(v)).join('\n')
  : '';
const budget = (elapsed, remainingPages, spent) => {
  const left = Math.min(2500, 10000 - spent, require('./ocrLimits').JOB_MS - elapsed - 5000 - remainingPages * 4000);
  return left >= 500 ? left : 0;
};
module.exports = { candidates, alternatives, note, budget, MAX_WORDS, ROW_HEIGHT };
