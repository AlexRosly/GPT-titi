const {fail} = require('../files/validation');
const policy = require('./policy');
const formula = require('./formula');

const isPlan = ops => ops.some(op => op.type === 'set_formula');
const contains = (b, c, r) => c >= b.c1 && c <= b.c2 && r >= b.r1 && r <= b.r2;
function targets(operations, selection) {
  if (selection.where) throw fail('XLSX_FORMULA_FILTERED_SELECTION');
  const edits = new Map();
  for (const op of operations) {
    if (op.type !== 'set_formula') throw fail('XLSX_FORMULA_MIXED_ACTIONS');
    const b = policy.range(op.range);
    if (!b || !contains(selection.range,b.c1,b.r1) || !contains(selection.range,b.c2,b.r2)) throw fail('XLSX_INVALID_RANGE');
    const size = (b.c2-b.c1+1)*(b.r2-b.r1+1);
    if (size + edits.size > 50000) throw fail('XLSX_FORMULA_LIMIT');
    for (let r=b.r1; r<=b.r2; r++) for (let c=b.c1; c<=b.c2; c++) {
      const ref = formula.colName(c)+r;
      if (edits.has(ref)) throw fail('XLSX_FORMULA_OVERLAP ('+ref+')');
      edits.set(ref,{r,c,ref,op,b});
    }
  }
  return edits;
}
function at(sheet, ref, run) {
  try { return run(); }
  catch (e) {
    if (e.fileError && !e.fileError.includes(' (')) throw fail(e.fileError+' ('+sheet+'!'+ref+')');
    throw e;
  }
}
function effective(cell) {
  const def = cell.definition;
  if (def.type === 'normal' && def.expression) return formula.parse(def.expression);
  if (def.type !== 'shared' || !def.master) throw fail('XLSX_FORMULA_UNSUPPORTED');
  const original = policy.range(def.master.cell), member = policy.range(cell.ref);
  if (!contains(policy.range(def.master.range),member.c1,member.r1)) throw fail('XLSX_FORMULA_REFERENCE');
  return formula.parse(def.master.expression,member.c1-original.c1,member.r1-original.r1);
}

// Each durable checkpoint carries one line per inspected row. Resuming translates
// only the remaining rows. Dependency calculation is a single finalization pass.
function indexTargets(operations, selection, rows) {
  const edits=targets(operations,selection), byRow=new Map();
  for(const edit of edits.values()){
    if(!byRow.has(edit.r))byRow.set(edit.r,[]);
    byRow.get(edit.r).push(edit);
  }
  const existing=new Set(rows.map(row=>row.r));
  for(const edit of edits.values())if(!existing.has(edit.r))throw fail('XLSX_FORMULA_ROW_MISSING ('+edit.ref+')');
  return {edits,byRow,sheet:selection.sheet};
}
function translate(edit) {
  return formula.parse(edit.op.formula,edit.c-edit.b.c1,edit.r-edit.b.r1);
}
function stage(request,row) {
  const edits=request.byRow.get(row.r)||[];
  const entries=edits.map(edit=>[edit.ref,at(request.sheet,edit.ref,()=>translate(edit).expression)]);
  return {xml:JSON.stringify(entries)+'\n',matched:1,changed:edits.length,formulaSkipped:0,nonNumericSkipped:0};
}
function restore(request,rows,chunk) {
  const lines=chunk.xml.split('\n');
  const count=chunk.processed-chunk.cursor;
  if(lines.pop()!==''||lines.length!==count)throw fail('DOCUMENT_CHECKPOINT_INVALID');
  for(let i=0;i<count;i++){
    const edits=request.byRow.get(rows[chunk.cursor+i].r)||[];
    let entries;
    try {entries=JSON.parse(lines[i]);} catch {throw fail('DOCUMENT_CHECKPOINT_INVALID');}
    if(!Array.isArray(entries)||entries.length!==edits.length)throw fail('DOCUMENT_CHECKPOINT_INVALID');
    for(const [j,edit] of edits.entries()){
      const entry=entries[j], expected=translate(edit);
      if(!Array.isArray(entry)||entry.length!==2||entry[0]!==edit.ref||entry[1]!==expected.expression)
        throw fail('DOCUMENT_CHECKPOINT_INVALID');
      edit.staged=expected;
    }
  }
}
function build(book, requested, selection) {
  const engine = require('./engine');
  const calculation = book.parts.get('xl/workbook.xml').toString('utf8').match(/<calcPr\b[^>]*>/)?.[0] || '';
  if (/\bfullPrecision=["'](?:0|false)["']/.test(calculation)) throw fail('XLSX_FORMULA_PRECISION_AS_DISPLAYED');
  const sheets = new Map(), allFormulas = [];
  let scanned = 0, visits = 0;
  for (const info of book.sheets) {
    const sheet = engine.sheetData(book,info.name,{readShared:true});
    const cells = new Map(), updates = new Map(), groups = new Set();
    const active = info.name === selection.sheet;
    // Check each requested address, including blank cells within merged regions.
    if (active) {
      if (/<sheetProtection\b/.test(sheet.xml)) throw fail('XLSX_FORMULA_SHEET_PROTECTED ('+info.name+')');
      for (const edit of requested.values()) {
        if (sheet.merges.some(b => contains(b,edit.c,edit.r) && (edit.c !== b.c1 || edit.r !== b.r1))) throw fail('XLSX_MERGED_TARGET ('+edit.ref+')');
      }
    }
    const state = {sheet,cells,updates};
    sheets.set(info.name.toUpperCase(),state);
    for (const row of sheet.rows) {
      for (const cell of engine.cells(book,sheet.xml.slice(row.start,row.end),row.r,sheet.shared).values()) {
        if (++scanned > 400000) throw fail('XLSX_FORMULA_LIMIT');
        const item = {ref:cell.ref, r:row.r, c:cell.col, cell, state};
        cells.set(cell.ref,item);
        if (active && requested.has(cell.ref) && cell.definition?.type === 'shared') {
          if (!cell.definition.master) throw fail('XLSX_FORMULA_REFERENCE ('+cell.ref+')');
          groups.add(cell.definition.master.cell);
        }
        if (cell.formula && !['normal','shared'].includes(cell.definition.type))
          throw fail('XLSX_FORMULA_UNSUPPORTED ('+info.name+'!'+cell.ref+')');
      }
    }
    if (active) for (const edit of requested.values()) {
      if (!edit.staged) throw fail('DOCUMENT_CHECKPOINT_INVALID');
      let item = cells.get(edit.ref);
      if (!item) {
        item = {ref:edit.ref,r:edit.r,c:edit.c,state};
        cells.set(edit.ref,item);
      }
      item.target = true;
      item.formula = edit.staged;
    }
    for (const item of cells.values()) {
      if (!item.formula && item.cell?.formula) {
        item.formula = at(info.name,item.ref,()=>effective(item.cell));
        item.split = item.cell.definition.type === 'shared' && groups.has(item.cell.definition.master.cell);
      }
      if (item.formula) allFormulas.push(item);
    }
  }
  function calculate(item, depth) {
    if (item.done) return item.result;
    if (item.busy) throw fail('XLSX_FORMULA_CYCLE');
    if (depth > 256) throw fail('XLSX_FORMULA_LIMIT');
    item.busy = true;
    item.affected = Boolean(item.target);
    item.result = at(item.state.sheet.name,item.ref,()=>formula.scalar(formula.evaluate(item.formula.tree,ref=>{
      if (++visits > 1000000) throw fail('XLSX_FORMULA_LIMIT');
      const source = ref.sheet ? sheets.get(ref.sheet.toUpperCase()) : item.state;
      if (!source) throw fail('XLSX_FORMULA_SHEET_NOT_FOUND');
      const dep = source.cells.get(formula.colName(ref.c)+ref.r);
      if (!dep) return null;
      if (!dep.formula) {
        if (dep.cell.type === 'd') throw fail('XLSX_FORMULA_NON_NUMERIC');
        if (dep.cell.type === 'e') throw fail('XLSX_FORMULA_INPUT_ERROR');
        return dep.cell.value;
      }
      const result = calculate(dep,depth+1);
      if (dep.affected) item.affected = true;
      return result;
    })));
    item.busy = false;
    item.done = true;
    return item.result;
  }
  let verifiedCount = 0;
  for (const item of allFormulas) {
    calculate(item,0);
    if (!(item.affected || item.split)) continue;
    verifiedCount++;
    const updates = item.state.updates;
    if (!updates.has(item.r)) updates.set(item.r,[]);
    updates.get(item.r).push(item);
  }
  return {sheets, verifiedCount, targetCount:requested.size};
}

function rewrite(book,state,row,raw) {
  const edits = state.updates.get(row.r);
  if (!edits) return raw;
  const engine = require('./engine');
  const values = engine.cells(book,raw,row.r);
  const replacements = edits.map(item=>{
    const cell = values.get(item.c);
    const xml = cell ? raw.slice(cell.start,cell.end) : '';
    const explicit = item.target || item.split;
    if (cell) {
      // Refuse ancillary cell children instead of dropping rich text or extensions.
      if (!/^<c\s/.test(xml) || /<(?!\/?(?:c|f|v|is|t)(?:[\s/>]))/.test(xml)) throw fail('XLSX_FORMULA_CELL_FEATURE ('+item.ref+')');
      if (/\s(?:cm|vm)\s*=/.test(xml.slice(0,xml.indexOf('>')))) throw fail('XLSX_FORMULA_CELL_FEATURE ('+item.ref+')');
    }
    const attrs = cell ? xml.slice(2,xml.indexOf('>')).replace(/\/?\s*$/,'').replace(/\s+t\s*=\s*(?:"[^"]*"|'[^']*')/,'') : ' r="'+item.ref+'"';
    const f = explicit ? '<f>'+engine.escape(item.formula.expression)+'</f>' : xml.match(/<f(?:\s[^>]*?)?(?:\s*\/>|>[\s\S]*?<\/f>)/)?.[0];
    if (!f) throw fail('XLSX_FORMULA_CELL_FEATURE ('+item.ref+')');
    const replacement = '<c'+attrs+'>'+f+'<v>'+item.result+'</v></c>';
    const start = cell?.start ?? [...values.values()].find(other=>other.col>item.c)?.start ?? raw.lastIndexOf('</row>');
    return {start,end:cell?.end??start,c:item.c,replacement};
  }).sort((a,b)=>b.start-a.start || b.end-a.end || b.c-a.c);
  let xml = raw;
  if (replacements.some(edit=>edit.start<0)) {
    if (values.size || !/^<row\b[^>]*\/>$/.test(raw)) throw fail('XLSX_UNSUPPORTED');
    xml = raw.slice(0,-2)+'>'+replacements.reverse().map(e=>e.replacement).join('')+'</row>';
  } else for (const edit of replacements) xml = xml.slice(0,edit.start)+edit.replacement+xml.slice(edit.end);
  if (edits.some(item=>!values.has(item.c))) xml=xml.replace(/^<row\b[^>]*>/, tag=>tag.replace(/\s+spans\s*=\s*(?:"[^"]*"|'[^']*')/,''));
  return xml;
}

function verify(book,plan) {
  const engine = require('./engine');
  for (const {sheet,updates} of plan.sheets.values()) {
    if (!updates.size) continue;
    const output = engine.sheetData(book,sheet.name,{readShared:true});
    let checkedRows = 0;
    for (const row of output.rows) {
      if (!updates.has(row.r)) continue;
      checkedRows++;
      const cells = engine.cells(book,output.xml.slice(row.start,row.end),row.r,output.shared);
      for (const item of updates.get(row.r)) {
        const cell = cells.get(item.c);
        if (!cell?.formula || effective(cell).expression!==item.formula.expression || cell.value!==item.result)
          throw fail('XLSX_VERIFICATION_FAILED ('+sheet.name+'!'+item.ref+')');
      }
    }
    if (checkedRows !== updates.size) throw fail('XLSX_VERIFICATION_FAILED');
  }
}
module.exports = {isPlan,targets,indexTargets,stage,restore,build,rewrite,verify};
