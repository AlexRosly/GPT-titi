const {fail} = require('../files/validation');
const formula = require('./formula');
const {effective} = require('./formulaEdit');
const policy = require('./policy');

const maxFormulaCells = 400000;
const maxReferences = 1000000;
const sampleSize = 8;

function addUpdate(state, item) {
  if (!state.updates.has(item.r)) state.updates.set(item.r,[]);
  state.updates.get(item.r).push(item);
}

// Checkpoints created before this release hold edited row XML. Compare the
// persisted values to the original here, so a resumed job uses the same inputs.
function build(book, originalSheet, selection, operations, expectedChanges) {
  const engine = require('./engine');
  const sheets = new Map(), nodes = [], changedInputs = new Set();
  const report = {verifiedCount:0, verifiedSample:[], unverifiedCount:0, unverifiedSample:[], clearedRangeCells:0};
  const plan = {sheets, report};
  for (const info of book.sheets) {
    const sheet = engine.sheetData(book,info.name,{readShared:true,indexFormulas:true});
    sheets.set(info.name.toUpperCase(),{sheet,rows:new Map(sheet.rows.map(row=>[row.r,row])),drivers:new Map(),updates:new Map()});
  }
  if (![...sheets.values()].some(state=>state.sheet.formulaCount)) return plan;
  const active = sheets.get(originalSheet.name.toUpperCase());
  const columns = operations.map(op=>policy.column(op.column));
  // Keep ordinary inputs in their original XML. Fetch only rows read by a
  // dependent expression; wide books need not keep every input cell in RAM.
  const rowCache = new Map();
  let cachedCells = 0;
  function readRow(state,row) {
    let values = rowCache.get(row);
    if (values) return values;
    values = engine.cells(book,state.sheet.xml.slice(row.start,row.end),row.r,state.sheet.shared);
    while (rowCache.size && (cachedCells+values.size>8192 || rowCache.size>=64)) {
      const first = rowCache.keys().next().value;
      cachedCells -= rowCache.get(first).size;
      rowCache.delete(first);
    }
    rowCache.set(row,values);
    cachedCells += values.size;
    return values;
  }
  function readCell(state,r,c) {
    const row = state.rows.get(r);
    return row && readRow(state,row).get(c);
  }
  for (const state of sheets.values()) {
    const {sheet} = state;
    for (const [i,row] of sheet.rows.entries()) {
      if (state === active && row.r >= selection.range.r1 && row.r <= selection.range.r2) {
        const prior = originalSheet.rows[i];
        if (!prior || prior.r !== row.r) throw fail('DOCUMENT_CHECKPOINT_INVALID');
        const old = originalSheet.xml.slice(prior.start,prior.end);
        if (old !== sheet.xml.slice(row.start,row.end)) {
          const before = engine.cells(book,old,row.r);
          const values = readRow(state,row);
          for (const col of columns) {
            const after = values.get(col);
            if ((after?.value ?? null) !== (before.get(col)?.value ?? null)) {
              changedInputs.add(formula.colName(col)+row.r);
            }
          }
        }
      }
      if (!row.hasFormula) continue;
      for (const cell of readRow(state,row).values()) {
        if (!cell.formula) continue;
        if (nodes.length >= maxFormulaCells) throw fail('XLSX_FORMULA_LIMIT ('+sheet.name+'!'+cell.ref+')');
        const item = {state,cell,ref:cell.ref,r:row.r,c:cell.col,cacheOnly:true};
        state.drivers.set(cell.ref,item);
        nodes.push(item);
      }
    }
  }
  if (changedInputs.size !== expectedChanges) throw fail('DOCUMENT_CHECKPOINT_INVALID');

  // Multi-cell Excel formulas own their entire result area. A reference to
  // a spill/table follower must not use that follower's old numeric cache.
  let references = 0;
  function visit(item) {
    if (++references > maxReferences) throw fail('XLSX_FORMULA_LIMIT ('+item.state.sheet.name+'!'+item.ref+')');
  }
  for (const item of nodes) {
    const def = item.cell.definition;
    if (!def.range || def.type === 'shared' || def.type === 'normal') continue;
    const bounds = policy.range(def.range);
    const {state} = item;
    item.members = [];
    for (let r=bounds.r1; r<=bounds.r2; r++) for (let c=bounds.c1; c<=bounds.c2; c++) {
      visit(item);
      const ref = formula.colName(c)+r;
      if (ref === item.ref) continue;
      if (state.drivers.has(ref)) throw fail('XLSX_FORMULA_OVERLAP ('+state.sheet.name+'!'+ref+')');
      state.drivers.set(ref,item);
      const cell = readCell(state,r,c);
      if (cell && cell.cacheStart !== undefined) item.members.push({state,cell,ref,r,c,cacheOnly:true,result:null});
    }
  }

  const affected = new Set();
  function locate(item,ref) {
    visit(item);
    const state = ref.sheet ? sheets.get(ref.sheet.toUpperCase()) : item.state;
    return {state,address:formula.colName(ref.c)+ref.r};
  }
  function link(driver,dependent) {
    if (!driver) return;
    if (!driver.dependents) driver.dependents = new Set();
    driver.dependents.add(dependent);
  }
  for (const item of nodes) {
    try {
      item.parsed = effective(item.cell,true);
    } catch (error) {
      if (!error.fileError) throw error;
      // Dynamic references and unknown syntax may read any changed input.
      item.problem = error.fileError;
      affected.add(item);
      continue;
    }
    if (!item.parsed.calculable || !['normal','shared'].includes(item.cell.definition.type))
      item.problem = 'XLSX_FORMULA_UNSUPPORTED';
    function addReference(ref) {
      if (references >= maxReferences) {
        item.problem = 'XLSX_FORMULA_LIMIT';
        affected.add(item);
        return;
      }
      const {state,address} = locate(item,ref);
      if (state === active && changedInputs.has(address)) affected.add(item);
      link(state?.drivers.get(address),item);
    }
    function addRange({from,to}) {
      const r1=Math.min(from.r,to.r), r2=Math.max(from.r,to.r);
      const c1=Math.min(from.c,to.c), c2=Math.max(from.c,to.c);
      const size=(r2-r1+1)*(c2-c1+1);
      const state=from.sheet?sheets.get(from.sheet.toUpperCase()):item.state;
      if (!state) return;
      const candidates=state.drivers.size+(state===active?changedInputs.size:0);
      if (Math.min(size,candidates)>maxReferences-references) {
        item.problem='XLSX_FORMULA_LIMIT';
        affected.add(item);
        return;
      }
      if (size>maxReferences) item.problem='XLSX_FORMULA_LIMIT';
      if (size<=candidates) {
        for(let r=r1;r<=r2;r++) for(let c=c1;c<=c2;c++) addReference({sheet:from.sheet,c,r});
        return;
      }
      // A sparse range can cover a million blank rows. Only changed inputs
      // and formula outputs can connect it to the edit.
      function inside(ref) {
        visit(item);
        const p=policy.range(ref);
        return r1<=p.r1&&p.r1<=r2&&c1<=p.c1&&p.c1<=c2;
      }
      if(state===active) for(const ref of changedInputs) if(inside(ref)) affected.add(item);
      for(const [ref,driver] of state.drivers) if(inside(ref)) link(driver,item);
    }
    formula.eachReference(item.parsed.tree,addReference,addRange);
  }
  // Set iteration includes newly appended entries and terminates on cycles.
  for (const item of affected) {
    if (item.dependents) for (const next of item.dependents) affected.add(next);
  }

  const calculation = book.parts.get('xl/workbook.xml').toString('utf8').match(/<calcPr\b[^>]*>/)?.[0] || '';
  const precisionAsDisplayed = /\bfullPrecision=["'](?:0|false)["']/.test(calculation);
  references = 0;
  function calculate(item,depth) {
    if (item.problem) throw fail(item.problem);
    if (item.result !== undefined) return item.result;
    if (item.busy) throw fail('XLSX_FORMULA_CYCLE');
    if (depth > 256) throw fail('XLSX_FORMULA_LIMIT');
    if (precisionAsDisplayed) throw fail('XLSX_FORMULA_PRECISION_AS_DISPLAYED');
    item.busy = true;
    try {
      item.result = formula.scalar(formula.evaluate(item.parsed.tree,ref=>{
        const {state,address} = locate(item,ref);
        if (!state) throw fail('XLSX_FORMULA_SHEET_NOT_FOUND');
        const driver = state.drivers.get(address);
        if (driver) return calculate(driver,depth+1);
        const cell = readCell(state,ref.r,ref.c);
        if (cell?.type === 'e') throw fail('XLSX_FORMULA_INPUT_ERROR');
        if (cell?.type === 'd') throw fail('XLSX_FORMULA_NON_NUMERIC');
        return cell?.value ?? null;
      }));
      return item.result;
    } catch (error) {
      if (error.fileError) item.problem = error.fileError;
      throw error;
    } finally { item.busy = false; }
  }

  for (const item of affected) {
    const address = {sheet:item.state.sheet.name,cell:item.ref};
    try {
      calculate(item,0);
      report.verifiedCount++;
      if (report.verifiedSample.length < sampleSize) report.verifiedSample.push(address);
    } catch (error) {
      if (!error.fileError) throw error;
      item.problem = error.fileError;
      item.result = null;
      report.unverifiedCount++;
      if (report.unverifiedSample.length < sampleSize)
        report.unverifiedSample.push({...address,reason:item.problem});
      for (const member of item.members || []) {
        addUpdate(item.state,member);
        report.clearedRangeCells++;
      }
    }
    addUpdate(item.state,item);
  }
  return plan;
}

module.exports = {build};
