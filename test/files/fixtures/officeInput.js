const { Document, Packer, Paragraph, Table, TableRow, TableCell } = require('docx');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const docx = async (text = 'Україна — 42', tail = 'Кінець') => Packer.toBuffer(new Document({ sections: [{ children: [
  new Paragraph(text), new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('Товар')] }), new TableCell({ children: [new Paragraph('Кількість')] })] }), new TableRow({ children: [new TableCell({ children: [new Paragraph('Яблука')] }), new TableCell({ children: [new Paragraph('42')] })] })] }), new Paragraph(tail),
] }] }));
const xlsx = async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Дані').addRows([['Товар', 'Кількість'], ['Яблука', 42], ['Груші', 7], ['Разом', { formula: 'SUM(B2:B3)', result: 49 }], ['Без кешу', { formula: '1+2' }], ['Текст', '=IMPORTXML("https://example.test")']]);
  book.getWorksheet('Дані').getCell('D1').value = new Date('2026-10-17T00:00:00Z');
  book.getWorksheet('Дані').getCell('D1').numFmt = 'yyyy-mm-dd';
  book.addWorksheet('Прихований', { state: 'hidden' }).addRow(['Значення', true]);
  return Buffer.from(await book.xlsx.writeBuffer());
};
const mutate = async (buffer, fn) => { const zip = await JSZip.loadAsync(buffer); await fn(zip); return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); };
module.exports = { docx, xlsx, mutate };
