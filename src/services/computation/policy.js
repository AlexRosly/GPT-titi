const fail = code => Object.assign(new Error(code), {fileError:code,status:422});
function number(name, fallback, min, max, integer = true) {
  const n=Number(process.env[name] ?? fallback);
  if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isSafeInteger(n))) throw fail('COMPUTE_CONFIGURATION_ERROR');
  return n;
}
function limits() { return {
  runMs:number('COMPUTE_RUN_MS',60000,1000,60000), totalMs:number('COMPUTE_TOTAL_MS',180000,1000,180000),
  runs:number('COMPUTE_MAX_RUNS',5,1,5), calls:number('COMPUTE_MAX_CALLS',6,1,6),
  memoryMiB:number('COMPUTE_MEMORY_MIB',512,256,1024), slots:number('COMPUTE_SERVER_SLOTS',2,1,2),
  usd:number('COMPUTE_MAX_USD',0.05,0.001,0.05,false), outputTokens:2048,
  inputBytes:25*1024**2, outputBytes:25*1024**2, files:10, codeBytes:32768, textBytes:16384,
  durationMs:600000, tmpMiB:256,
}; }
const enabled = model => process.env.COMPUTE_V2_ENABLED === 'true' && process.env.PRIVATE_FILES_ENABLED === 'true' && !!model && model.computationEnabled !== false;
const tool = {type:'function',function:{name:'run_python',description:'Run Python for verified calculations, data analysis and file processing. No network or package installation. Libraries: pandas, numpy, openpyxl, matplotlib, Pillow. Read only selected fileIds from COMPUTATION_FILES; their paths are /work/input/<fileId>/<originalName>. Each run starts fresh; export intermediate results explicitly to reuse at /work/previous/<filename>. Write outputs to /work/output/<path>. For TXT/CSV/JSON/SVG/code write UTF-8. For PDF/DOCX/XLSX write the document JSON manifest described in the Office rules, and export with the requested final extension; the server builds the real binary. PNG plots are supported. Do not use pandas.to_excel for XLSX exports; export {sheets:[{name,rows}]} as JSON. Export ZIP by writing a create_file ZIP JSON manifest. At most 10 exports, 512 KiB per text/manifest, 25 MiB total. No executable output is run. Never claim successful calculation or file creation without a successful tool result.',strict:true,parameters:{type:'object',additionalProperties:false,properties:{code:{type:'string'},fileIds:{type:'array',items:{type:'string'}},exports:{type:'array',items:{type:'object',additionalProperties:false,properties:{path:{type:'string'},filename:{type:'string'}},required:['path','filename']}}},required:['code','fileIds','exports']}}};
function parse(raw) {
  let v;try{v=JSON.parse(raw);}catch{throw fail('COMPUTE_INVALID_ACTION');}
  if(!v||Object.keys(v).some(k=>!['code','fileIds','exports'].includes(k))||typeof v.code!=='string'||!v.code.trim()||Buffer.byteLength(v.code)>limits().codeBytes||!Array.isArray(v.fileIds)||v.fileIds.length>10||v.fileIds.some(id=>typeof id!=='string'||!/^[a-f\d]{24}$/i.test(id))||new Set(v.fileIds).size!==v.fileIds.length||!Array.isArray(v.exports)||v.exports.length>10)throw fail('COMPUTE_INVALID_ACTION');
  const names=new Set(),paths=new Set();
  for(const e of v.exports){
    if(!e||Object.keys(e).length!==2||typeof e.path!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(e.path)||e.path.includes('..'))throw fail('COMPUTE_INVALID_ACTION');
    require('../files/validation').safeName(e.filename);
    const key=e.filename.normalize('NFC').toLowerCase();
    if(names.has(key)||paths.has(e.path))throw fail('COMPUTE_INVALID_ACTION');names.add(key);paths.add(e.path);
    if(!/\.png$/i.test(e.filename))require('../files/artifacts').outputSpec({filename:e.filename});
  }
  return v;
}
function collector(){let name='',args='',id='',bad=false,reason;return {
  add(chunk){const c=chunk.choices?.[0];if(c?.finish_reason)reason=c.finish_reason;for(const t of c?.delta?.tool_calls||[]){if(t.index!==0)bad=true;name+=t.function?.name||'';id+=t.id||'';if(!bad){args+=t.function?.arguments||'';if(Buffer.byteLength(args)>65536){bad=true;args='';}}}},
  finish(){if(name!=='run_python')return null;if(bad||reason!=='tool_calls'||!id)throw fail('COMPUTE_INVALID_ACTION');return {id,type:'function',function:{name,arguments:args}};}
};}
module.exports={fail,limits,enabled,tool,parse,collector};
