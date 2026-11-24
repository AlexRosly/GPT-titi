// One public transcription for a page. Alternative evidence is scoped to its
// original occurrence, never used to rewrite another row or another page.
const unknown = '[нерозбірливо]';
const revision = 4;

function identifier(word, latin, second, glyph) {
  const match = /^([ОOQ])([АA])([-–][0-9]+)$/u.exec(word.text);
  if (match) {
    const shape = glyph(word, 0, 'QO');
    if (shape === 'O' && /^(?:ОА|OA)$/u.test(match[1]+match[2]) && word.confidence >= 80) return word.text;
    if (shape === 'Q' && latin === 'QA' + match[3] && second === latin) return latin;
    return unknown;
  }
  // For other scripts a Latin-only reread is not proof of a change of alphabet.
  if (latin && latin !== word.text) return unknown;
  return word.confidence >= 80 ? word.text : unknown;
}

function wordText(recognized, edits) {
  let i = 0;
  return recognized.lines.map((line, n) => {
    const prefix = n && line.paragraph !== recognized.lines[n-1].paragraph ? '\n' : '';
    return prefix + line.words.map(text => edits.get(recognized.words[i++]) ?? text).join(' ');
  }).join('\n');
}

function disputedWords(line, other) {
  const a = line.split(/\s+/), b = other.split(/\s+/);
  if (a.length === b.length) return a.map((w,i) => w === b[i] ? w : unknown).join(' ');
  let left = 0, right = 0;
  while (left < Math.min(a.length,b.length) && a[left] === b[left]) left++;
  while (right < Math.min(a.length,b.length)-left && a[a.length-right-1] === b[b.length-right-1]) right++;
  return [...a.slice(0,left),unknown,...(right ? a.slice(-right) : [])].join(' ');
}

function regions(text, evidence) {
  const lines = text.split('\n');
  const offsets = lines.map((s,i) => s.trim() ? i : -1).filter(i => i >= 0);
  for (const item of evidence) {
    const ids = item.sourceLines || [item.line];
    if (!Array.isArray(ids) || !ids.length || !ids.every(n => Number.isInteger(n) && offsets[n-1] !== undefined)) continue;
    const positions = ids.map(n => offsets[n-1]);
    const fragments = positions.map(n => lines[n]);
    const source = fragments.join(' ');
    if (fragments.join('\n') !== item.original || typeof item.alternative !== 'string') continue;
    const supplied = item.crossCheck?.readings;
    const readings = Array.isArray(supplied) && supplied.length <= 2 && supplied.every(r=>r && typeof r.text==='string') ? supplied : [];
    const agreed = item.crossCheck?.status === 'agreement' && item.numericAgreement === true &&
      item.recognitionIncomplete === false && readings.length === 2 &&
      readings.every(r => r.text === item.alternative && r.numericAgreement === true && r.recognitionIncomplete === false);
    // Preserve the positions of non-adjacent OCR fragments when evidence is incomplete.
    if (positions.length > 1 && !ids.every((id,i) => id === ids[0]+i)) {
      if (agreed) {
        lines[positions[0]] = item.alternative;
        for (const pos of positions.slice(1)) lines[pos] = '';
      } else {
        const words = source.split(/\s+/);
        const alternatives = [item.alternative,...readings.map(r=>r.text)];
        const perWord = alternatives.map(s=>s.split(/\s+/));
        let offset = 0;
        for (const pos of positions) {
          const count = lines[pos].split(/\s+/).length;
          lines[pos] = words.slice(offset,offset+count).map((w,i) =>
            perWord.every(list=>list.length===words.length && list[offset+i]===w) ? w : unknown).join(' ');
          offset += count;
        }
      }
      continue;
    }
    let value = agreed ? item.alternative : disputedWords(source,item.alternative);
    if (!agreed) {
      for (const r of readings) if (r.text !== item.alternative) value = disputedWords(value,r.text);
    }
    lines[positions[0]] = value;
    for (const pos of positions.slice(1)) lines[pos] = '';
  }
  return lines.join('\n');
}

// Older caches stored JSON after the OCR body. Never promote their unchecked
// suggestions. Process only OCR sections; leave native PDF text layers alone.
function legacy(text) {
  if (!text.includes('[OCR IDENTIFIER ALTERNATIVES') && !text.includes('[OCR REGION ALTERNATIVES')) return text;
  const pages = text.split(/(?=^\[(?:PDF|IMAGE) PAGE \d+ OF \d+ — (?:OCR|TEXT LAYER)\]$)/mu);
  return pages.map(page => {
    if (!/^\[(?:PDF|IMAGE) PAGE \d+ OF \d+ — OCR\]/u.test(page)) return page;
    const rows = page.split('\n');
    const at = rows.findIndex(s => /^\[OCR (?:IDENTIFIER|REGION) ALTERNATIVES\b/.test(s));
    if (at < 0) return page;
    const head = rows.slice(0,at);
    const start = head.findIndex((s,i) => i > 0 && s.trim() && !/^\[(?:OCR MODELS:|OCR QUALITY UNCERTAIN:|SCRIPT SELECTION UNCERTAIN:)/.test(s));
    const data = start < 0 ? [] : head.splice(start);
    let kind, incomplete = false;
    const disputed = new Set(), regionValues = [];
    for (const row of rows.slice(at)) {
      if (/^\[OCR (IDENTIFIER|REGION) ALTERNATIVES\b/.test(row)) { kind = row.startsWith('[OCR IDENTIFIER') ? 'id' : 'region'; continue; }
      if (row.startsWith('[OCR ') && row.includes('CHECK INCOMPLETE')) { incomplete = true; continue; }
      if (!row.trim()) continue;
      try {
        const v = JSON.parse(row);
        if (kind === 'id' && typeof v.original === 'string') disputed.add(v.original);
        if (kind === 'region' && typeof v.original === 'string') regionValues.push(v);
      } catch { /* Not parseable verification evidence. */ }
    }
    const body = regions(data.join('\n'),regionValues).split(/(\s+)/u).map(w => disputed.has(w) ? unknown : w).join('');
    return [...head,body,...(incomplete ? ['[OCR REGION CHECK INCOMPLETE: Some regions could not be verified.]'] : [])].join('\n') + (page.endsWith('\n') ? '\n' : '');
  }).join('');
}
const cachedText = cache => cache.qualityRevision === revision ? cache.text : legacy(cache.text);
module.exports = { unknown, revision, identifier, wordText, regions, legacy, cachedText };
