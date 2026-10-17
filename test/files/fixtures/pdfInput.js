const PDFDocument = require('pdfkit');
const path = require('node:path');
const makePdf = (pages = ['Україна — 42', 'Second page: 731'], options = {}, decorate = () => {}) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ autoFirstPage: false, ...options });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
  doc.registerFont('Test', path.resolve(__dirname, '../../../src/services/files/fonts/DejaVuSans.ttf'));
  for (const text of pages) {
    doc.addPage();
    if (text) doc.font('Test').fontSize(11).text(text, 50, 50);
    else doc.rect(50, 50, 200, 100).fill('#446688'); // Visible content, deliberately no text layer.
  }
  decorate(doc);
  doc.end();
});
module.exports = { makePdf };
