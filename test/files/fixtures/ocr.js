const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const path = require('node:path');
const PDFDocument = require('pdfkit');
GlobalFonts.registerFromPath(path.resolve(__dirname, '../../../src/services/files/fonts/DejaVuSans.ttf'), 'OCRFixture');
const makeImage = (text = 'INVOICE 731 TOTAL 4200', format = 'image/png') => {
  const c = createCanvas(1400, 300), x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 1400, 300); x.fillStyle = '#000'; x.font = '48px OCRFixture'; x.fillText(text, 40, 130);
  return c.toBuffer(format);
};
const makeScan = (pages = ['INVOICE 731 TOTAL 4200'], options = {}) => new Promise((resolve, reject) => {
  const d = new PDFDocument({ autoFirstPage: false, ...options }), chunks = [];
  d.on('data', b => chunks.push(b)); d.on('end', () => resolve(Buffer.concat(chunks))); d.on('error', reject);
  for (const p of pages) { d.addPage(); if (typeof p === 'object') d.text(p.text, 40, 40); else d.image(makeImage(p), 30, 50, { width: 550 }); }
  d.end();
});
module.exports = { makeImage, makeScan };
