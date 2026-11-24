const fs = require('node:fs');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const languages = require('./ocrLanguages');
const identifiers = require('./ocrIdentifiers');
const reading = require('./ocrReading');
const glyphs = require('./ocrGlyphs');

const qrPrefix = /^[QOО][AА][-–]\d{1,12}$/u;
const suffix = /[-–]\d+$/u;

function writeRows(words, source, file) {
  const sheet = createCanvas(2048,words.length*identifiers.ROW_HEIGHT);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0,0,sheet.width,sheet.height);
  words.forEach((word,i) => {
    const x = Math.max(0,word.left-8), y = Math.max(0,word.top-8);
    const w = Math.min(source.width-x,word.width+16), h = Math.min(source.height-y,word.height+16);
    const scale = Math.min(2,96/h,2000/w);
    ctx.drawImage(source,x,y,w,h,16,i*identifiers.ROW_HEIGHT+16,w*scale,h*scale);
  });
  fs.writeFileSync(file,sheet.toBuffer('image/png'),{mode:0o600});
}

function collect(words,result) {
  const values = new Map();
  words.forEach((word,i) => {
    const row = result.words.filter(w => Math.floor((w.top+w.height/2)/identifiers.ROW_HEIGHT) === i);
    if (row.length !== 1 || row[0].confidence < 80 || !/^[A-Z]{2,24}[-–]\d{1,12}$/.test(row[0].text)) return;
    if (suffix.exec(row[0].text)[0] === suffix.exec(word.text)[0]) values.set(word,row[0].text);
  });
  return values;
}

async function resolve(recognized, buffer, {setting, available, file, run, budget, diagnostic}) {
  const edits = new Map();
  const answer = {text:recognized.text,source:null,notes:'',uncertain:false,incomplete:false,spent:0};
  if (setting !== 'auto' && !/(?:^|\+)(?:ukr|rus|bel|bul|srp|(?:script\/)?Cyrillic)(?:$|\+)/.test(setting)) return answer;

  const cyrillicCodes = new Set(identifiers.candidates(recognized.words));
  const codes = recognized.words.filter(w => cyrillicCodes.has(w) || qrPrefix.test(w.text));
  const hooked = diagnostic ? [] : recognized.words.filter(w => /[ГгҐґ]/u.test(w.text) &&
    /^\p{Script=Cyrillic}+[.,;:!?]?$/u.test(w.text));
  if (!codes.length && !hooked.length) return answer;
  const source = answer.source = await loadImage(buffer);
  const readGlyph = glyphs.reader(source);
  let pixels = 2000000, glyphCount = 0;
  function glyph(word,index,pair) {
    // Cap optional work on pages with very large or repeated candidate words.
    pixels -= word.width * word.height;
    if (++glyphCount > 192 || pixels < 0) { answer.incomplete = true; return null; }
    return readGlyph(word,index,pair);
  }
  const latin = languages.resolveScript('Latin',available) || (available.has('eng') ? 'eng' : null);
  let offset = 0;
  for (; offset < codes.length; offset+=identifiers.MAX_WORDS) {
    const timeout = budget(answer.spent);
    if (!latin || !timeout || (diagnostic && offset)) break;
    const group = codes.slice(offset,offset+identifiers.MAX_WORDS);
    const start = Date.now();
    let first = new Map(), second = new Map();
    try {
      writeRows(group,source,file);
      const left = () => timeout - (Date.now()-start);
      if (left() > 0) {
        const result = run([latin],6,left(),file);
        first = collect(group,result);
        if (diagnostic) answer.notes = identifiers.note(identifiers.alternatives(group,result));
      }
      if (!diagnostic && group.some(w=>qrPrefix.test(w.text)) && left() > 0) {
        second = collect(group,run([available.has('eng') ? 'eng' : latin],11,left(),file));
      }
    } catch { answer.incomplete = true; }
    answer.spent += Date.now()-start;
    if (!diagnostic) for (const word of group) {
      // Preserve a genuinely Cyrillic prefix when supported by its pixels. An
      // unverified alphabet change elsewhere must not enter the transcription.
      const a = first.get(word), b = second.get(word);
      const value = reading.identifier(word,a,b,glyph);
      edits.set(word,value);
    }
  }
  if (offset < codes.length) {
    answer.incomplete = true;
    for (const word of codes.slice(offset)) edits.set(word,reading.unknown);
  }
  if (diagnostic) { answer.uncertain = codes.length > 0; return answer; }
  for (const word of hooked) {
    const letters = [...word.text];
    for (let i=0; i<letters.length; i++) {
      if (!/[ГгҐґ]/u.test(letters[i])) continue;
      const pair = /[ГҐ]/u.test(letters[i]) ? 'ГҐ' : 'гґ';
      const result = glyph(word,i,pair);
      if (!result) { edits.set(word,reading.unknown); break; }
      letters[i] = result;
      edits.set(word,letters.join(''));
    }
  }
  answer.uncertain = [...edits.values()].includes(reading.unknown);
  answer.text = reading.wordText(recognized,edits);
  return answer;
}

module.exports = {resolve};
