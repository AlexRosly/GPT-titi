const ExcelJS = require('exceljs');
const {fail} = require('../files/validation');
const {preview} = require('../files/office');
const {encodeCellText} = require('./engine');
const formula = require('./formula');

function formatSheet(sheet) {
  sheet.getRow(1).font = {bold: true, color: {argb: 'FF142443'}};
  sheet.getRow(1).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFE9EEF5'}};
  for (const column of sheet.columns) {
    let width = 12;
    column.eachCell(cell => {
      width = Math.max(width, Math.min(45, String(cell.result ?? cell.value ?? '').length + 2));
      cell.alignment = {vertical: 'top', wrapText: true};
    });
    column.width = width;
  }
  sheet.autoFilter = {from: {row: 1, column: 1}, to: {row: Math.max(1, sheet.rowCount), column: Math.max(1, sheet.columnCount)}};
  sheet.pageSetup = {paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0};
}

// Resolve against the complete manifest, including sheets and cells appearing
// later in the request. Reading blank references must not allocate Excel cells.
function calculateFormulas(sheets, formulas) {
  const byName = new Map(sheets.map(sheet => [sheet.name.toLowerCase(), sheet]));
  const calculate = formula.workbookCalculator((item, ref, calculateDependency) => {
    const source = ref.sheet ? byName.get(ref.sheet.toLowerCase()) : item.source;
    if (!source) throw fail('XLSX_FORMULA_SHEET_NOT_FOUND');
    const input = source.rows[ref.r - 1]?.[ref.c - 1] ?? null;
    if (input?.type === 'formula') return calculateDependency(formulas.get(input));
    return input?.type === 'number' ? input.value : input;
  });
  for (const item of formulas.values()) {
    item.cell.value = {formula: item.formula.expression, result: calculate(item)};
  }
}

function verifiedPreview(manifest, saved, formulas) {
  const sheets = manifest.sheets.map((source, i) => {
    const sheet = saved.worksheets[i];
    if (sheet?.name !== source.name) throw fail('XLSX_VERIFICATION_FAILED');
    const rows = source.rows.map((row, r) => row.map((input, c) => {
      const cell = sheet.getCell(r + 1, c + 1);
      const expected = formulas.get(input);
      if (expected) {
        if (cell.formula !== expected.formula.expression || cell.result !== expected.result) {
          throw fail('XLSX_VERIFICATION_FAILED ('+source.name+'!'+cell.address+')');
        }
      } else if (cell.value !== (input?.type === 'number' ? input.value : input)) {
        throw fail('XLSX_VERIFICATION_FAILED ('+source.name+'!'+cell.address+')');
      }
      if (input?.numberFormat && (cell.numFmt ?? 'General') !== input.numberFormat) {
        throw fail('XLSX_VERIFICATION_FAILED ('+source.name+'!'+cell.address+')');
      }
      return expected ? cell.result : cell.value;
    }));
    return {name: sheet.name, rows};
  });
  return preview('xlsx', {sheets});
}

module.exports = async function generate(manifest, maxBytes) {
  const book = new ExcelJS.Workbook();
  book.creator = 'GPTiti';
  const formulas = new Map();
  let hasTypedCells = false;
  for (const source of manifest.sheets) {
    const sheet = book.addWorksheet(source.name, {views: [{state: 'frozen', ySplit: 1}]});
    source.rows.forEach((row, r) => row.forEach((input, c) => {
      const cell = sheet.getCell(r + 1, c + 1);
      if (input?.type) {
        hasTypedCells = true;
        if (input.numberFormat) cell.numFmt = input.numberFormat;
      }
      if (input?.type === 'formula') {
        const parsed = formula.atCell(source.name, cell.address, () => formula.parse(input.formula));
        formulas.set(input, {source, sheetName: source.name, ref: cell.address, cell, formula: parsed});
      } else if (typeof input === 'string') {
        cell.value = encodeCellText(input);
      } else {
        cell.value = input?.type === 'number' ? input.value : input;
      }
    }));
  }
  if (formulas.size) {
    calculateFormulas(manifest.sheets, formulas);
    book.calcProperties.fullCalcOnLoad = true;
  }
  book.worksheets.forEach(formatSheet);
  const buffer = Buffer.from(await book.xlsx.writeBuffer());
  if (buffer.length > maxBytes) throw fail('FILE_TOO_LARGE');
  if (!hasTypedCells) return {buffer, generatedPreview: preview('xlsx', manifest)};

  const saved = new ExcelJS.Workbook();
  await saved.xlsx.load(buffer);
  return {buffer, generatedPreview: verifiedPreview(manifest, saved, formulas)};
};
