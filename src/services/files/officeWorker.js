const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const { fail } = require('./validation');
const { ext, value, maxBytes } = workerData;
async function pdf() {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: value.title, Creator: 'GPTiti' } });
    const chunks = []; let size = 0, pages = 1;
    doc.on('data', chunk => { size += chunk.length; if (size > maxBytes) { doc.destroy(); reject(fail('FILE_TOO_LARGE')); } else chunks.push(chunk); });
    doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('pageAdded', () => { if (++pages > 80) throw fail('DOCUMENT_LIMIT_EXCEEDED'); });
    try {
      doc.registerFont('Body', path.join(__dirname, 'fonts/DejaVuSans.ttf'));
      doc.registerFont('Bold', path.join(__dirname, 'fonts/DejaVuSans-Bold.ttf'));
      const width = doc.page.width - 100;
      const body = () => doc.font('Body').fontSize(10).fillColor('#25354a');
      if (value.title) { doc.font('Bold').fontSize(21).fillColor('#142443').text(value.title, { width }); doc.moveDown(.7); }
      for (const block of value.blocks) {
        body();
        if (block.type === 'table') {
          const col = width / block.rows[0].length;
          const height = (row, header) => { doc.font(header ? 'Bold' : 'Body').fontSize(9); return Math.max(...row.map(cell => doc.heightOfString(cell || ' ', { width: col - 12 }))) + 14; };
          const draw = (row, header) => {
            const h = height(row, header), top = doc.y;
            row.forEach((cell, index) => {
              const x = 50 + index * col;
              doc.rect(x, top, col, h).fillAndStroke(header ? '#e9eef5' : '#ffffff', '#d7dfe9');
              doc.fillColor('#25354a').text(cell || ' ', x + 6, top + 7, { width: col - 12, lineGap: 0 });
            });
            doc.x = 50; doc.y = top + h;
          };
          const header = block.rows[0], headerHeight = height(header, true);
          if (headerHeight > doc.page.height - 150) throw fail('DOCUMENT_LAYOUT_LIMIT');
          for (let i = 0; i < block.rows.length; i++) {
            const h = height(block.rows[i], i === 0);
            if (h + (i ? headerHeight : 0) > doc.page.height - 110) throw fail('DOCUMENT_LAYOUT_LIMIT');
            if (doc.y + h > doc.page.height - 55) { doc.addPage(); if (i) draw(header, true); }
            draw(block.rows[i], i === 0);
          }
          doc.moveDown(.8);
        } else if (block.type === 'heading') {
          if (doc.y > doc.page.height - 135) doc.addPage();
          doc.font('Bold').fontSize(14).fillColor('#142443').text(block.text, { width }); doc.moveDown(.5);
        } else {
          body().text((block.type === 'bullet' ? '• ' : '') + block.text, 50, doc.y, { width, paragraphGap: 8, lineGap: 3 }); doc.moveDown(.5);
        }
      }
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i); doc.page.margins.bottom = 0;
        doc.font('Body').fontSize(8).fillColor('#64748b').text(`${i + 1} / ${range.count}`, 50, doc.page.height - 30, { width, align: 'center', lineBreak: false });
      }
      doc.end();
    } catch (e) { doc.destroy(); reject(e); }
  });
}
async function docx() {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel, Footer, PageNumber, AlignmentType } = require('docx');
  const para = (text, options = {}) => new Paragraph({ ...options, children: text.split(/\r?\n/).map((line, index) => new TextRun({ text: line, break: index ? 1 : 0 })) });
  const children = [];
  if (value.title) children.push(para(value.title, { heading: HeadingLevel.TITLE }));
  for (const block of value.blocks) {
    if (block.type === 'table') children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: block.rows.map((row, i) => new TableRow({ tableHeader: i === 0, children: row.map(cell => new TableCell({ shading: i === 0 ? { fill: 'E9EEF5' } : undefined, children: [para(cell)] })) })) }));
    else children.push(para(block.text, block.type === 'heading' ? { heading: HeadingLevel.HEADING_1, keepNext: true } : block.type === 'bullet' ? { bullet: { level: 0 } } : {}));
  }
  const document = new Document({ creator: 'GPTiti', title: value.title, styles: { default: { document: { run: { font: 'Arial', size: 22 }, paragraph: { spacing: { after: 160, line: 276 } } } } }, sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES] })] })] }) } }] });
  return Packer.toBuffer(document);
}
async function xlsx() {
  const ExcelJS = require('exceljs'); const book = new ExcelJS.Workbook(); book.creator = 'GPTiti';
  for (const source of value.sheets) {
    const sheet = book.addWorksheet(source.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    // Primitives only: never formula objects, hyperlinks, macros or external data.
    sheet.addRows(source.rows);
    sheet.getRow(1).font = { bold: true, color: { argb: 'FF142443' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF5' } };
    sheet.columns.forEach(column => { let width = 12; column.eachCell({ includeEmpty: false }, cell => { width = Math.max(width, Math.min(45, String(cell.value ?? '').length + 2)); cell.alignment = { vertical: 'top', wrapText: true }; }); column.width = width; });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: Math.max(1, sheet.columnCount) } };
    sheet.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
(async () => {
  try {
    const buffer = await ({ pdf, docx, xlsx })[ext]();
    if (buffer.length > maxBytes) throw fail('FILE_TOO_LARGE');
    parentPort.postMessage({ buffer });
  } catch (e) { parentPort.postMessage({ error: e.fileError || 'DOCUMENT_RENDER_FAILED' }); }
})();
