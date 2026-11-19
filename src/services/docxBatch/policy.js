const {fail,safeName}=require('../files/validation');
const enabled=model=>process.env.DOCX_BATCH_ENABLED==='true' && process.env.DOCUMENT_JOBS_ENABLED==='true' && require('../docx/policy').enabled(model);
const inspectName='inspect_docx_batch',editName='edit_docx_batch';
const isTool=name=>name===inspectName || name===editName;
const str={type:'string'};
function tool(name,description,properties) {
  return {type:'function',function:{name,strict:true,description,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}};
}
const tools=[
  tool(inspectName,'Scan all main-body paragraphs in this DOCX, including table cells, for an exact whole paragraph literal. Standalone text in a single Word text run is supported. No header/footer or partial text replacement. Exact match total and checksum-bound selection include undisplayed paragraphs.',{fileId:str,find:str}),
  tool(editName,'Terminal operation. Replace ALL matching whole paragraphs selected by inspect_docx_batch in a verified DOCX copy. Use only when the user requested a document-wide replacement. Durable chunks resume after restart. Never use this to perform a scoped table cell, signature, or formatting edit.',
    {fileId:str,sourceChecksum:str,selectionId:str,expectedMatches:{type:'integer',minimum:1},value:str,filename:str}),
];
function literal(value){
  return typeof value==='string' && value.length>0 && value.length<=500 && value===value.trim() &&
    !/[\x00-\x1f\ufffe\uffff]/u.test(value) && Buffer.from(value).toString('utf8')===value;
}
function parse(name,raw){
  if(!isTool(name)||typeof raw!=='string'||Buffer.byteLength(raw)>8192)throw fail('DOCX_BATCH_INVALID_ACTION');
  let a;try{a=JSON.parse(raw);}catch{throw fail('DOCX_BATCH_INVALID_ACTION');}
  const fields=tools.find(t=>t.function.name===name).function.parameters.required;
  if(!a||typeof a!=='object'||Object.keys(a).length!==fields.length||!fields.every(k=>Object.hasOwn(a,k))||
    typeof a.fileId!=='string'||!/^[a-f0-9]{24}$/.test(a.fileId))throw fail('DOCX_BATCH_INVALID_ACTION');
  if(name===inspectName){if(!literal(a.find))throw fail('DOCX_BATCH_INVALID_ACTION');}
  else{
    if(!literal(a.value)||![a.sourceChecksum,a.selectionId].every(s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s))||
      !Number.isSafeInteger(a.expectedMatches)||a.expectedMatches<1||a.expectedMatches>400000||
      !/\.docx$/i.test(safeName(a.filename)))throw fail('DOCX_BATCH_INVALID_ACTION');
  }
  return a;
}
const instructions='For a document-wide replacement of an exact whole paragraph, inspect_docx_batch scans every body paragraph, including paragraphs in tables. Use edit_docx_batch with its full match count and a new filename to finish as a resumable background job. Use ordinary inspect_docx/edit_docx for targeted cells, borders or formatting. Do not infer exact pagination from structural counts.';
module.exports={enabled,isTool,inspectName,editName,tools,instructions,parse};
