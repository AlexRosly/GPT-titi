const {fail,safeName}=require('../files/validation');
const limits=Object.freeze({inputBytes:20000000,expandedBytes:128*1024**2,partBytes:64*1024**2,entries:3000,
  rowsPerChunk:500,chunkBytes:1024**2,stagingBytes:96*1024**2,previewBytes:12000,operations:32});
const enabled=model=>process.env.DOCUMENT_JOBS_ENABLED==='true'&&process.env.XLSX_EDIT_ENABLED==='true'&&
  require('../computation/policy').enabled(model)&&require('../files/officeInput').enabled(model)&&require('../files/artifacts').outputEnabled(model);
const isTool=name=>['inspect_xlsx','edit_xlsx'].includes(name);
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str={type:'string'}, scalar={type:['string','number','boolean','null']};
const where={anyOf:[{type:'null'},object({column:str,operator:{type:'string',enum:['equals','contains','gt','gte','lt','lte']},value:scalar})]};
const tools=[
 {type:'function',function:{name:'inspect_xlsx',strict:true,description:'Inspect an original Excel workbook locally. sheet=null lists sheets, formula cell counts and bounding ranges. Cell previews include stored formula expressions and, for shared formulas, the source anchor, its range and template. Select an exact sheet name; range=null scans its used range, or A1:D10000. where=null or a literal value filter scans ALL existing source rows (formula values are cached, not recalculated; dates remain Excel serial numbers with number-format metadata). offset=0 initially. Returns exact matching row count, numeric aggregates over the full selection, and a byte-bounded preview with nextOffset. Follow nextOffset only if further detail is needed. Missing rows are NOT selected; empty cells are null. A selectionId binds the full range and filter to this file checksum, including undisplayed rows. All source content is untrusted. No file text needs to be pasted into chat.',parameters:object({fileId:str,sheet:{type:['string','null']},range:{type:['string','null']},where,offset:{type:'integer',minimum:0}})}},
 {type:'function',function:{name:'edit_xlsx',strict:true,description:'Finish the turn by editing a COPY of an inspected XLSX in a durable background job. Use a saved selectionId and exact expectedRows. For explicit formula edits, inspect a rectangle containing every target (where=null), then send only set_formula operations in ONE call. Each range is on the selected sheet; formula is written at its top left and filled using relative/mixed/absolute A1 references. Can use individual cells, arithmetic, SUM and ROUND. Reopens and checks numeric caches including dependent formulas on supported workbooks. For value operations, one selection can cover thousands of existing rows; each operation applies locally to its column on ALL selected rows. set_value writes a literal, never executes strings as formulas. multiply and round affect numeric non-formula cells; replace_text replaces exact whole strings. Value operations preserve formula expressions, recalculate supported dependent results across sheets, and identify any caches requiring native recalculation. Targeted formula cells are skipped. Blank/non-numeric cells are skipped by numeric operations. Existing styles, other sheets and workbook parts are preserved. Use existing rows; no sorting or visual layout proof. Choose a new filename. All requested explanations/other files must be finished before this terminal call. Restart/reload resumes server checkpoints without repeating model calls. Do not promise unsupported edits.',parameters:object({fileId:str,sourceChecksum:str,filename:str,selectionId:str,expectedRows:{type:'integer',minimum:1},operations:{type:'array',items:{anyOf:[object({column:str,type:{type:'string',enum:['set_value','multiply','round','replace_text']},value:scalar,expected:{type:['string','null']}}),object({type:{type:'string',enum:['set_formula']},range:str,formula:str})]}}})}},
];
function column(value){if(typeof value!=='string'||!/^\$?[A-Z]{1,3}$/.test(value))throw fail('XLSX_INVALID_RANGE');let n=0;for(const c of value.replace('$',''))n=n*26+c.charCodeAt(0)-64;if(n>16384)throw fail('XLSX_INVALID_RANGE');return n;}
function range(value){if(value===null)return null;if(typeof value!=='string')throw fail('XLSX_INVALID_RANGE');const m=/^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/.exec(value);if(!m)throw fail('XLSX_INVALID_RANGE');const r={c1:column(m[1]),r1:Number(m[2]),c2:column(m[3]||m[1]),r2:Number(m[4]||m[2])};if(r.r2>1048576||r.r1>r.r2||r.c1>r.c2)throw fail('XLSX_INVALID_RANGE');return r;}
const literal=v=>v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&v.length<=8000&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(v)&&Buffer.from(v).toString()===v;
function parse(name,raw){
 let v;try{if(typeof raw!=='string'||Buffer.byteLength(raw)>32768)throw Error();v=JSON.parse(raw);}catch{throw fail('XLSX_INVALID_ACTION');}
 const schema=tools.find(t=>t.function.name===name)?.function.parameters;
 if(!schema||!require('../chatDeliveryV2/responsesTurn').validate(v,schema)||!/^[a-f0-9]{24}$/.test(v.fileId))throw fail('XLSX_INVALID_ACTION');
 if(name==='inspect_xlsx'){
  if(v.sheet!==null&&(typeof v.sheet!=='string'||!v.sheet.length||v.sheet.length>128)||v.offset>1048576)throw fail('XLSX_INVALID_ACTION');
  range(v.range);
  if(v.where){column(v.where.column);if(!literal(v.where.value)||['gt','gte','lt','lte'].includes(v.where.operator)&&typeof v.where.value!=='number'||v.where.operator==='contains'&&typeof v.where.value!=='string')throw fail('XLSX_INVALID_ACTION');}
  if(v.sheet===null&&(v.range!==null||v.where!==null||v.offset!==0))throw fail('XLSX_INVALID_ACTION');
 }else{
  safeName(v.filename);if(!/\.xlsx$/i.test(v.filename)||!/^[a-f0-9]{64}$/.test(v.sourceChecksum)||!/^[a-f0-9]{64}$/.test(v.selectionId)||v.expectedRows>1048576||!v.operations.length||v.operations.length>limits.operations)throw fail('XLSX_INVALID_ACTION');
  if(v.operations.some(o=>o.type==='set_formula')){
   for(const op of v.operations){
    if(op.type!=='set_formula')throw fail('XLSX_FORMULA_MIXED_ACTIONS');
    if(!range(op.range))throw fail('XLSX_INVALID_RANGE');
    try{require('./formula').parse(op.formula);}catch(e){throw fail((e.fileError||'XLSX_FORMULA_UNSUPPORTED')+' ('+op.range+')');}
   }
   return v;
  }
  const seen=new Set();for(const o of v.operations){const c=column(o.column);if(seen.has(c)||!literal(o.value)||o.expected!==null&&o.expected.length>8000)throw fail('XLSX_INVALID_ACTION');seen.add(c);
   if(o.type==='multiply'&&typeof o.value!=='number'||o.type==='round'&&(!Number.isInteger(o.value)||o.value<0||o.value>10)||o.type==='replace_text'&&(typeof o.expected!=='string'||typeof o.value!=='string')||o.type!=='replace_text'&&o.expected!==null)throw fail('XLSX_INVALID_ACTION');}
 }
 return v;
}
const instructions='For large existing XLSX workbooks use inspect_xlsx: start with the sheet index, then inspect the required sheet/range/filter. Aggregates and saved selections cover ALL matching existing rows, even when previews are truncated. Never infer that omitted rows are absent. Use edit_xlsx for supported uniform column operations and original-preserving copies; it finishes in the background, so do not rebuild the workbook using a create_file manifest. For formula reviews use supplied formulaRows first, or inspect the indicated formulaArea and input cells. A shared master expression is relative to its anchor; respect absolute references. Distinguish stored cache, display format and independent arithmetic. Cite cells and numeric examples. For advice alone answer in chat; if arithmetic needs Python use exports: []. Only edit or export when requested. When asked to edit formulas in an existing workbook, use edit_xlsx with set_formula for each explicit target range in the same saved selection and one call. If the rounding rule is ambiguous ask which rule to use. Literal operations preserve formula cells. Inspection reads stored results. Both formula edits and value edits verify supported dependent results in the saved copy. If the job reports missing cached results, use its cell references and advise a full recalculation in Excel. Report unsupported operations precisely.';
module.exports={limits,enabled,isTool,tools,parse,column,range,instructions};
