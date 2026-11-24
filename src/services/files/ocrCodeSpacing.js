// Confirm an OCR-inserted space only inside a labelled numeric identifier.
const { createCanvas } = require('@napi-rs/canvas');
const field = /^(?:контрольний код|код|control code|verification code|code)\s*[:：]?\s+([0-9]+(?: [0-9]+)+)$/iu;

function codeBox(pieces, original) {
  if (pieces.map(word => word.text).join(' ') !== original ||
      pieces.some(word => word.confidence < 80)) return;
  const digits = original.replaceAll(' ', '');
  if (digits.length < 5 || digits.length > 16) return;
  const left = pieces[0].left;
  const top = Math.min(...pieces.map(word => word.top));
  const bottom = Math.max(...pieces.map(word => word.top + word.height));
  const width = pieces.at(-1).left + pieces.at(-1).width - left;
  const height = bottom - top;
  if (height < 10 || width < digits.length * 5 || width * height > 180000) return;
  for (let i = 1; i < pieces.length; i++) {
    const a = pieces[i-1], b = pieces[i];
    // Word boxes can end inside a digit on Tesseract 4. Measure spacing on the original pixels below.
    if (b.left < a.left + a.width ||
        Math.abs(a.top + a.height - b.top - b.height) > height * 0.2) return;
  }
  return { left, top, width, height, digits, original };
}

// On tabular digits, a real space increases the distance between glyph centres.
// Abstain on touching/broken glyphs, tiny type, proportional spacing or extra ink.
function uniformDigits(ctx, width, height, count) {
  const { data } = ctx.getImageData(8, 8, width, height);
  const centers = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    let dark = 0;
    if (x < width) {
      for (let y = 0; y < height; y++) {
        const i = 4 * (y * width + x);
        if (Math.max(data[i], data[i + 1], data[i + 2]) < 150) {
          dark++;
          if (dark === 2) break;
        }
      }
    }
    if (dark >= 2 && start < 0) start = x;
    if (dark < 2 && start >= 0) {
      centers.push((start + x - 1) / 2);
      start = -1;
    }
  }
  if (centers.length !== count) return false;
  const steps = centers.slice(1).map((center,i) => center - centers[i]);
  const pitch = [...steps].sort((a,b) => a-b)[Math.floor(steps.length / 2)];
  return pitch >= 5 && steps.every(step => Math.abs(step - pitch) <= pitch * 0.15);
}

async function resolve(recognized, text, getSource, reread, budget) {
  const lines = text.split('\n');
  const positions = lines.flatMap((line, i) => line.trim() ? [i] : []);
  if (positions.length !== recognized.lines.length) return text;
  let cursor = 0, attempts = 0;
  for (const [i, line] of recognized.lines.entries()) {
    cursor += line.words.length;
    const original = lines[positions[i]];
    if (original !== line.words.join(' ')) continue;
    const match = field.exec(original);
    if (!match) continue;
    const count = match[1].split(' ').length;
    if (count >= line.words.length) continue;
    const box = codeBox(recognized.words.slice(cursor - count, cursor), match[1]);
    if (!box) continue;
    if (++attempts > 4 || !budget()) break;
    try {
      const source = await getSource();
      if (box.left < 0 || box.top < 0 || box.left + box.width > source.width || box.top + box.height > source.height) continue;
      const crop = createCanvas(box.width + 16, box.height + 16);
      const ctx = crop.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, crop.width, crop.height);
      ctx.drawImage(source, box.left, box.top, box.width, box.height, 8, 8, box.width, box.height);
      if (!uniformDigits(ctx, box.width, box.height, box.digits.length)) continue;
      const ms = budget();
      if (!ms) break;
      const words = reread(crop, ms).words;
      if (words.length === 1 && words[0].text === box.digits && words[0].confidence >= 85) {
        lines[positions[i]] = lines[positions[i]].slice(0, -box.original.length) + box.digits;
      }
    } catch { /* Optional verification. Keep the original spacing on failure. */ }
  }
  return lines.join('\n');
}
module.exports = { resolve };
