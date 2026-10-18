const { fail } = require('./validation');
// Read dimensions before native decoding; refuse unsupported/animated images.
module.exports = buffer => {
  let w, h;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    w = buffer.readUInt32BE(16); h = buffer.readUInt32BE(20);
    for (let p = 8; p + 12 <= buffer.length;) {
      const size = buffer.readUInt32BE(p);
      if (buffer.toString('ascii', p + 4, p + 8) === 'acTL') throw fail('OCR_INVALID_IMAGE');
      if (size > buffer.length - p - 12) throw fail('OCR_INVALID_IMAGE');
      p += size + 12;
    }
  } else if (buffer[0] === 255 && buffer[1] === 216) {
    let p = 2;
    while (p + 4 <= buffer.length) {
      if (buffer[p++] !== 255) throw fail('OCR_INVALID_IMAGE');
      while (buffer[p] === 255) p++;
      const marker = buffer[p++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > buffer.length) break;
      const size = buffer.readUInt16BE(p);
      if (size < 2 || p + size > buffer.length) throw fail('OCR_INVALID_IMAGE');
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 7) {
        h = buffer.readUInt16BE(p + 3); w = buffer.readUInt16BE(p + 5); break;
      }
      p += size;
    }
  } else if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const type = buffer.toString('ascii', 12, 16);
    if (type === 'VP8X') {
      if (buffer[20] & 2) throw fail('OCR_INVALID_IMAGE');
      w = 1 + buffer.readUIntLE(24, 3); h = 1 + buffer.readUIntLE(27, 3);
    } else if (type === 'VP8L' && buffer[20] === 47) {
      const n = buffer.readUInt32LE(21); w = (n & 16383) + 1; h = ((n >>> 14) & 16383) + 1;
    } else if (type === 'VP8 ' && buffer[23] === 157 && buffer[24] === 1 && buffer[25] === 42) {
      w = buffer.readUInt16LE(26) & 16383; h = buffer.readUInt16LE(28) & 16383;
    }
  }
  if (!w || !h) throw fail('OCR_INVALID_IMAGE');
  if (w > 10000 || h > 10000 || w * h > 16000000) throw fail('OCR_IMAGE_LIMIT', 413);
  return { width: w, height: h };
};
