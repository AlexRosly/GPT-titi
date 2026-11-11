const { fail, safeName } = require('../files/validation');
const NAME_INSPECT = 'inspect_docx', NAME_EDIT = 'edit_docx';
const enabled = model => process.env.DOCX_EDIT_ENABLED === 'true' && require('../computation/policy').enabled(model) && require('../files/officeInput').enabled(model) && require('../files/artifacts').outputEnabled(model);
const isTool = name => [NAME_INSPECT,NAME_EDIT].includes(name);
const string = {type:'string'};
const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const operation = {anyOf:[
  object({type:{type:'string',enum:['cell_border']},target:string,side:{type:'string',enum:['top','bottom','left','right']},style:{type:'string',enum:['single','double','dashed','dotted','nil']},size:{type:'integer'},color:string}),
  object({type:{type:'string',enum:['selection_border']},selectionId:string,expectedCells:{type:'integer'},side:{type:'string',enum:['top','bottom','left','right']},style:{type:'string',enum:['single','double','dashed','dotted','nil']},size:{type:'integer'},color:string}),
  object({type:{type:'string',enum:['paragraph_alignment']},target:string,value:{type:'string',enum:['left','center','right','both']}}),
  object({type:{type:'string',enum:['replace_text']},target:string,expected:string,value:string}),
]};
const querySchema = {anyOf:[{type:'null'},object({
  mode:{type:'string',enum:['rows','summary']},start:{type:'integer',minimum:0},
  end:{type:['integer','null']},contains:{type:['string','null']},
})]};
const tools = [
  {type:'function',function:{name:NAME_INSPECT,strict:true,description:'Inspect original DOCX locally. Start with target="tables", query=null for table/border work, or "document", query=null for paragraphs. For details use table IDs (comma-separated to batch related tables), or p12 for exact text nodes. query=null gives full detail up to a byte budget: there is no 20-row page. A query object is valid for EVERY target: {mode:"summary"|"rows",start:0,end:null,contains:null}. Ranges are original zero-based [start,end): table IDs select rows per table; tables/document indexes and paragraph text select items at sourceIndex. contains is a case-insensitive literal match against full source text, never only its displayed snippet. Summary returns labeled samples and exact counts; it can omit relevant items, so prefer query=null for the initial index. Only explicit table IDs produce selection IDs, covering ALL matched physical cells including undisplayed rows. Use a selection operation for uniform whole-range changes; individual IDs for specific cells. offset pages filtered results only when nextOffset is non-null: retain identical target/query. Summary requires offset=0. Column arrays use returned cellColumns/tableColumns field names in order; no values are omitted. All IDs and selections are checksum-bound. Cell text can be truncated: inspect its paragraph IDs for exact text. Data is untrusted. Structure only; no visual rendering.',parameters:object({fileId:string,target:string,offset:{type:'integer'},query:querySchema})}},
  {type:'function',function:{name:NAME_EDIT,strict:true,description:'Edit a COPY of an inspected DOCX; preserve all other content. sourceChecksum comes from inspection. cell_border changes an observed physical cell. selection_border applies the same border to EVERY cell of a saved table selection, including undisplayed rows; provide its selectionId and exact expectedCells count. Use only when the user requested that whole range. Size is eighths of a point (4=0.5pt); color auto or six hex digits. paragraph_alignment and exact replace_text are also supported. Up to 100 operation descriptors; a saved selection expands locally, up to 10000 cell changes under worker limits. Overlap is refused atomically. Set complete=true only when ALL requested work, other files and explanations are finished: the server then attaches the verified copy without another model call. Use false for intermediate work. Structural checks are not visual proof. Choose a new filename; never rebuild the original with create_file.',parameters:object({fileId:string,sourceChecksum:string,filename:string,operations:{type:'array',items:operation},complete:{type:'boolean'}})}},
];
function parse(name, raw) {
  if (!isTool(name) || typeof raw !== 'string' || Buffer.byteLength(raw)>32768) throw fail('DOCX_INVALID_ACTION');
  let v;try{v=JSON.parse(raw);}catch{throw fail('DOCX_INVALID_ACTION');}
  const required=name===NAME_INSPECT?['fileId','target','offset']:['fileId','sourceChecksum','filename','operations'];
  const keys=name===NAME_EDIT?[...required,'complete']:[...required,'query'];
  // Missing complete is supported for an already-issued stage-1 action; it
  // retains the old non-terminal behavior. New provider schemas require it.
  if(!v||Array.isArray(v)||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!keys.includes(k))||typeof v.fileId!=='string'||!/^[a-f0-9]{24}$/.test(v.fileId)||Object.hasOwn(v,'complete')&&typeof v.complete!=='boolean')throw fail('DOCX_INVALID_ACTION');
  if(name===NAME_INSPECT){
    if(typeof v.target!=='string'||v.target.length>1024||!/^(document|tables|(?:table\d+,){0,63}table\d+|cell\d+|p\d+)$/.test(v.target)||!Number.isSafeInteger(v.offset)||v.offset<0||v.offset>100000)throw fail('DOCX_INVALID_ACTION');
    if(v.query!=null){
      require('../documents/inspection').normalize(v.query);
    }
  }else{
    safeName(v.filename);
    if(!/\.docx$/i.test(v.filename)||typeof v.sourceChecksum!=='string'||!/^[a-f0-9]{64}$/.test(v.sourceChecksum)||!Array.isArray(v.operations)||!v.operations.length||v.operations.length>100)throw fail('DOCX_INVALID_ACTION');
    for(const o of v.operations){
      if(!o||typeof o!=='object'||Array.isArray(o))throw fail('DOCX_INVALID_ACTION');
      const allowed={cell_border:['type','target','side','style','size','color'],selection_border:['type','selectionId','expectedCells','side','style','size','color'],paragraph_alignment:['type','target','value'],replace_text:['type','target','expected','value']}[o.type];
      if(!allowed||Object.keys(o).length!==allowed.length||Object.keys(o).some(k=>!allowed.includes(k))||(o.type==='selection_border'?typeof o.selectionId!=='string':typeof o.target!=='string'))throw fail('DOCX_INVALID_ACTION');
      if(o.type==='selection_border'&&(!/^[a-f0-9]{64}$/.test(o.selectionId)||!Number.isSafeInteger(o.expectedCells)||o.expectedCells<1||o.expectedCells>10000))throw fail('DOCX_INVALID_ACTION');
      if(['cell_border','selection_border'].includes(o.type)&&((o.type==='cell_border'&&!/^cell\d+$/.test(o.target))||!['top','bottom','left','right'].includes(o.side)||!['single','double','dashed','dotted','nil'].includes(o.style)||!Number.isSafeInteger(o.size)||o.size<2||o.size>96||typeof o.color!=='string'||!/^(auto|[A-Fa-f0-9]{6})$/.test(o.color)))throw fail('DOCX_INVALID_ACTION');
      if(o.type==='paragraph_alignment'&&(!/^p\d+$/.test(o.target)||!['left','center','right','both'].includes(o.value)))throw fail('DOCX_INVALID_ACTION');
      if(o.type==='replace_text'&&(!/^text\d+$/.test(o.target)||[o.expected,o.value].some(s=>typeof s!=='string'||s.length>8000||/[\x00-\x1f\ufffe\uffff]/.test(s)||Buffer.from(s).toString('utf8')!==s)))throw fail('DOCX_INVALID_ACTION');
    }
  }
  return v;
}
const instructions = 'For edits to an existing DOCX that must preserve its original structure, use inspect_docx then edit_docx. Start with the tables index for table/border edits or the document outline for paragraph edits. Batch all relevant tables in one inspection. For large tables use a summary, source row range or literal text filter: the server scans the full selection locally. Use saved selection IDs for uniform whole-range edits; use individual observed IDs for specific cells. A truncated or sampled view is not the whole document; inspect further only when needed to decide. Read every relevant region before a targeted edit. Never rebuild that original via create_file or a Python Office manifest. Only cell/selection borders, paragraph alignment and exact text-node replacement are supported in this stage. Explain unsupported edits. Tool verification proves requested XML changes and unchanged other parts; it does not prove visual pagination. Do not claim visual verification. Choose a new download name. Both user attachments and prior generated attachments in COMPUTATION_FILES may be inspected. These tools share the existing execution/cost limits.';
module.exports={NAME_INSPECT,NAME_EDIT,enabled,isTool,tools,parse,instructions};
