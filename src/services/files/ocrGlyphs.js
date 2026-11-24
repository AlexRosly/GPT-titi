// Compare just the ambiguous printed glyph against normalized masks at two ink thresholds.
// Each comparison is local to this occurrence. A word list cannot establish a spelling.
const templates = require('./ocrGlyphTemplates.json');
const { createCanvas } = require('@napi-rs/canvas');
const bitCount = new Uint8Array(65536);
for (let i = 1; i < bitCount.length; i++) bitCount[i] = bitCount[i >> 1] + (i & 1);

function classify(image, index, count, pair, threshold) {
  const { width, height, data } = image;
  const ink = (x, y) => data[(y * width + x) * 4] < threshold;
  // Connected components keep separately printed letters apart even when
  // kerning makes their horizontal extents overlap.
  const labels = new Int32Array(width * height);
  const queue = new Int32Array(labels.length);
  const components = [];
  let label = 0;
  for (let pos = 0; pos < labels.length; pos++) {
    if (labels[pos] || !ink(pos%width, Math.floor(pos/width))) continue;
    label++;
    let left = width, right = -1, top = height, bottom = -1, end = 1;
    queue[0] = pos; labels[pos] = label;
    for (let k=0; k<end; k++) {
      const pixel = queue[k], x = pixel%width, y = Math.floor(pixel/width);
      left=Math.min(left,x); right=Math.max(right,x); top=Math.min(top,y); bottom=Math.max(bottom,y);
      for (let dy=Math.max(0,y-1); dy<=Math.min(height-1,y+1); dy++) {
        for (let dx=Math.max(0,x-1); dx<=Math.min(width-1,x+1); dx++) {
          const n=dy*width+dx;
          if (!labels[n] && ink(dx,dy)) { labels[n]=label; queue[end++]=n; }
        }
      }
    }
    if (bottom-top+1 >= Math.max(6,height*0.28)) components.push({left,right,top,bottom,label});
  }
  components.sort((a,b) => a.left-b.left);
  if (!components[index] || (index > 0 && components.length !== count)) return null;
  const {left,right,top,bottom,label: selected} = components[index];
  const w = right-left+1, h = bottom-top+1;
  if (w < 7 || h < 12 || w/h < 0.25 || w/h > 1.5) return null;
  const rows = new Uint16Array(20);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 16; x++) {
    if (labels[(top+Math.floor((y+0.5)*h/20))*width+left+Math.floor((x+0.5)*w/16)] === selected) rows[y] |= 1 << x;
  }
  function similarity(char) {
    let best = 0;
    for (const sample of templates[char]) {
      let intersection = 0, union = 0;
      for (let y = 0; y < 20; y++) {
        intersection += bitCount[rows[y] & sample[y]];
        union += bitCount[rows[y] | sample[y]];
      }
      best = Math.max(best, intersection / union);
    }
    return best;
  }
  const a = similarity(pair[0]), b = similarity(pair[1]);
  if (Math.max(a,b) < 0.76 || Math.abs(a-b) < 0.065) return null;
  return a > b ? pair[0] : pair[1];
}

function reader(source) {
  const canvas = createCanvas(1, 1);
  return (word, index, pair) => {
    const {left, top, width, height} = word;
    if (width < 1 || height < 1 || width > 2048 || height > 256 || width*height > 160000) return null;
    const x = Math.max(0, left-2), y = Math.max(0, top-2);
    const w = Math.min(source.width-x, left+width+2-x), h = Math.min(source.height-y, top+height+2-y);
    if (w <= 0 || h <= 0) return null;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,w,h);
    ctx.drawImage(source,x,y,w,h,0,0,w,h);
    const pixels = ctx.getImageData(0,0,w,h);
    const a = classify(pixels,index,[...word.text].length,pair,128);
    return a && a === classify(pixels,index,[...word.text].length,pair,176) ? a : null;
  };
}
module.exports = { reader };
