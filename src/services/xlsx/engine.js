// Deterministic OOXML adapter. Never rebuild a workbook through a spreadsheet
// object model: only selected row spans and calculation caches are changed.
const sax=require('sax'),crypto=require('node:crypto'),path=require('node:path');
const {fail}=require('../files/validation');
const policy=require('./policy'),L=policy.limits;
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/package/2006/relationships';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const attr=(node,key)=>node.attributes[key]?.value;
const decode=value=>value.replace(/_x([0-9a-f]{4})_/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
const roundDecimal=(value,places)=>{const [mantissa,exponent='0']=Math.abs(value).toString().split('e');const [whole,fraction='']=mantissa.split('.');const shift=Number(exponent)-fraction.length+places;let n=BigInt(whole+fraction);if(shift<0){const d=10n**BigInt(-shift);n=n/d+(n%d*2n>=d?1n:0n);}else n*=10n**BigInt(shift);return Math.sign(value)*Number(n.toString()+'e-'+places);};
const bad=()=>{throw fail('XLSX_INVALID_DOCUMENT');};
function parse(xml,callbacks={}){
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))bad();
 const p=sax.parser(true,{xmlns:true,position:true});let depth=0;
 p.onerror=bad;
 p.onopentag=n=>{if(++depth>64)throw fail('XLSX_RESOURCE_LIMIT');callbacks.open?.(n,p.startTagPosition-1,p.position);};
 p.onclosetag=n=>{callbacks.close?.(n,p.position);depth--;};
 p.ontext=t=>callbacks.text?.(t);p.oncdata=t=>callbacks.text?.(t);
 try{p.write(xml).close();}catch(e){if(e.fileError)throw e;bad();}
}
function xmlOf(parts,name){const b=parts.get(name);if(!b)bad();try{return new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{bad();}}
function load(buffer){
 if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>L.inputBytes)throw fail('XLSX_FILE_LIMIT');
 const parts=require('../files/officeInputZip')(buffer,{all:true,maxExpanded:L.expandedBytes,maxPart:L.partBytes,maxEntries:L.entries});
 const rels=new Map(),namespaces=new Map();
 for(const [name,b]of parts){
  if(/_xmlsignatures|vbaProject|calcChain\.xml$/i.test(name)&&!name.endsWith('calcChain.xml'))throw fail('XLSX_UNSUPPORTED');
  if(!/\.(xml|rels)$/.test(name))continue;
  // Validate every XML part, and disallow active external relationships.
  parse(xmlOf(parts,name),{open:n=>{
   if(n.local==='worksheet'&&n.uri===NS)for(const [prefix,uri] of Object.entries(n.ns)){if(!prefix)continue;if(namespaces.has(prefix)&&namespaces.get(prefix)!==uri)throw fail('XLSX_UNSUPPORTED');namespaces.set(prefix,uri);}
   if(name.endsWith('.rels')&&n.local==='Relationship'){
    if(n.uri!==REL||attr(n,'TargetMode')==='External'||!attr(n,'Id')||!attr(n,'Target')||!attr(n,'Type'))throw fail('XLSX_UNSUPPORTED');
    if(name==='xl/_rels/workbook.xml.rels'){
     const id=attr(n,'Id'),target=attr(n,'Target');if(rels.has(id)||target.includes('\\')||target.includes('%')||target.includes(':'))bad();
     const resolved=target.startsWith('/')?target.slice(1):path.posix.normalize('xl/'+target);
     if(!resolved.startsWith('xl/')||resolved.includes('..'))bad();
     rels.set(id,{path:resolved,type:attr(n,'Type')});
    }
   }
  }});
 }
 const sheets=[];parse(xmlOf(parts,'xl/workbook.xml'),{open:n=>{if(n.local==='sheet'&&n.uri===NS){
  const name=attr(n,'name'),id=Object.values(n.attributes).find(a=>a.local==='id'&&a.uri==='http://schemas.openxmlformats.org/officeDocument/2006/relationships')?.value;
  const rel=rels.get(id);if(!name||sheets.some(s=>s.name===name)||!rel?.type.endsWith('/worksheet')||!parts.has(rel.path))throw fail('XLSX_UNSUPPORTED');
  sheets.push({name,path:rel.path});
 }}});if(!sheets.length||sheets.length>256)throw fail('XLSX_RESOURCE_LIMIT');
 const formats=new Map(),styles=[];
 if(parts.has('xl/styles.xml')){let cellStyles=false;parse(xmlOf(parts,'xl/styles.xml'),{open:n=>{if(n.uri!==NS)return;if(n.local==='numFmt')formats.set(Number(attr(n,'numFmtId')),attr(n,'formatCode'));if(n.local==='cellXfs')cellStyles=true;if(n.local==='xf'&&cellStyles){const id=Number(attr(n,'numFmtId')||0);styles.push({numberFormatId:id,numberFormat:formats.get(id)||null});}},close:n=>{if(n.split(':').at(-1)==='cellXfs')cellStyles=false;}});}
 const strings=[];
 if(parts.has('xl/sharedStrings.xml')){let text='',inside=false,capture=false,phonetic=0;parse(xmlOf(parts,'xl/sharedStrings.xml'),{
  open:n=>{if(n.uri!==NS)return;if(n.local==='si'){inside=true;text='';}if(n.local==='rPh')phonetic++;if(n.local==='t'&&inside&&!phonetic)capture=true;},
  text:t=>{if(capture)text+=t;},close:n=>{const local=n.split(':').at(-1);if(local==='t')capture=false;if(local==='rPh')phonetic--;if(local==='si'){if(text.length>32767)throw fail('XLSX_RESOURCE_LIMIT');strings.push(decode(text));inside=false;}}
 });}
 return {parts,sheets,strings,styles,rowNamespaces:[...namespaces].map(([p,u])=>`xmlns:${p}="${escape(u)}"`).join(" "),checksum:hash(buffer)};
}
function sheetData(book,name){
 const sheet=book.sheets.find(s=>s.name===name);if(!sheet)throw fail('XLSX_SHEET_NOT_FOUND');
 const xml=xmlOf(book.parts,sheet.path),rows=[],merges=[],formulaRanges=[];let current,prev=0,inData=false,dimension=null,maxColumn=0;
 parse(xml,{open:(n,start)=>{
  if(n.uri!==NS)return;
  if(n.local==='worksheet'&&n.prefix)throw fail('XLSX_UNSUPPORTED');
  if(n.local==='dimension')dimension=attr(n,'ref');
  if(n.local==='mergeCell')merges.push(policy.range(attr(n,'ref')));
  if(n.local==='f'&&attr(n,'ref'))formulaRanges.push(policy.range(attr(n,'ref')));
  if(n.local==='sheetData')inData=true;
  if(n.local==='row'&&inData){const r=Number(attr(n,'r'));if(current||!Number.isInteger(r)||r<=prev||r>1048576)bad();current={r,start};prev=r;}
  if(n.local==='c'&&current){const ref=attr(n,'r'),m=/^([A-Z]{1,3})([1-9]\d*)$/.exec(ref||'');if(!m||Number(m[2])!==current.r)bad();maxColumn=Math.max(maxColumn,policy.column(m[1]));}
 },close:(n,end)=>{const local=n.split(':').at(-1);if(local==='row'&&current){rows.push({...current,end});current=null;}if(local==='sheetData')inData=false;}});
 return {...sheet,xml,rows,merges,formulaRanges,dimension,maxColumn,used:{r1:rows[0]?.r||1,r2:rows.at(-1)?.r||1,c1:1,c2:maxColumn||1}};
}
function cells(book,rowXML,rowNumber){
 const result=new Map();let cell,capture=null,text='',last=0,phonetic=0;
 // The row inherits its namespace from worksheet; wrap it without changing offsets.
 const prefix=`<root xmlns="${NS}" ${book.rowNamespaces||""}>`;
 parse(prefix+rowXML+'</root>',{open:(n,start,end)=>{
  if(n.uri!==NS)return;
  if(n.local==='c'){
   const ref=attr(n,'r'),m=/^([A-Z]{1,3})([1-9]\d*)$/.exec(ref||'');if(!m||Number(m[2])!==rowNumber)bad();const col=policy.column(m[1]);if(col<=last)bad();last=col;
   cell={ref,col,start:start-prefix.length,openEnd:end-prefix.length,style:attr(n,'s'),type:attr(n,'t'),formula:false,value:null,inline:'',raw:''};
  }
  if(n.local==='rPh')phonetic++;
  if(cell&&['f','v','t'].includes(n.local)&&!phonetic){capture=n.local;text='';if(n.local==='f')cell.formula=true;}
 },text:t=>{if(capture)text+=t;},close:(n,end)=>{const local=n.split(':').at(-1);
  if(local==='rPh')phonetic--;
  if(cell&&local===capture){if(local==='t')cell.inline+=text;else if(local==='v')cell.raw=text;capture=null;}
  if(local==='c'&&cell){
   if(cell.type==='s'){const index=Number(cell.raw);if(!/^\d+$/.test(cell.raw)||index>=book.strings.length)bad();cell.value=book.strings[index];}
   else if(cell.type==='inlineStr')cell.value=decode(cell.inline);
   else if(['str','e','d'].includes(cell.type))cell.value=decode(cell.raw);
   else if(cell.type==='b'){if(!['0','1'].includes(cell.raw))bad();cell.value=cell.raw==='1';}
   else if(cell.raw!==''){if(!Number.isFinite(Number(cell.raw)))bad();cell.value=Number(cell.raw);}
   cell.end=end-prefix.length;result.set(cell.col,cell);cell=null;
  }
 }});return result;
}
const matches=(values,where)=>{
 if(!where)return true;const v=values.get(policy.column(where.column))?.value??null,w=where.value;
 switch(where.operator){case'equals':return v===w;case'contains':return typeof v==='string'&&v.toLocaleLowerCase('en-US').includes(w.toLocaleLowerCase('en-US'));case'gt':return typeof v==='number'&&v>w;case'gte':return typeof v==='number'&&v>=w;case'lt':return typeof v==='number'&&v<w;case'lte':return typeof v==='number'&&v<=w;default:throw fail('XLSX_INVALID_ACTION');}
};
const colName=n=>{let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;};
function selection(book,sheet,args){
 const range=policy.range(args.range)||sheet.used;
 if(args.where&&(policy.column(args.where.column)<range.c1||policy.column(args.where.column)>range.c2))throw fail('XLSX_INVALID_RANGE');
 const descriptor={version:1,sourceChecksum:book.checksum,sheet:sheet.name,range,where:args.where||null};
 return {...descriptor,id:hash(JSON.stringify(descriptor))};
}
function inspect(book,args){
 if(args.sheet===null)return {checksum:book.checksum,sheets:book.sheets.map(s=>{const d=sheetData(book,s.name);return {name:s.name,dimension:d.dimension,physicalRows:d.rows.length,lastRow:d.rows.at(-1)?.r||0,maxColumn:d.maxColumn};}),fullTextProvided:false};
 const sheet=sheetData(book,args.sheet),sel=selection(book,sheet,args),items=[],stats=new Map();let matched=0,shownBytes=0,nextOffset=null,scanned=0;
 for(const row of sheet.rows){if(row.r<sel.range.r1||row.r>sel.range.r2)continue;scanned++;
  const values=cells(book,sheet.xml.slice(row.start,row.end),row.r);if(!matches(values,sel.where))continue;
  const ordinal=matched++;const out=[];
  for(const [c,cell]of values){if(c<sel.range.c1||c>sel.range.c2)continue;
   if(sheet.formulaRanges.some(r=>r.r1<=row.r&&r.r2>=row.r&&r.c1<=c&&r.c2>=c))cell.formula=true;
   const stat=stats.get(c)||{column:colName(c),numericCount:0,sum:0,min:null,max:null,formulaCells:0};if(cell.formula)stat.formulaCells++;
   if(typeof cell.value==='number'){stat.numericCount++;stat.sum+=cell.value;stat.min=stat.min===null?cell.value:Math.min(stat.min,cell.value);stat.max=stat.max===null?cell.value:Math.max(stat.max,cell.value);}stats.set(c,stat);
   if(ordinal>=args.offset&&nextOffset===null)out.push({cell:cell.ref,...(book.styles[Number(cell.style||0)]||{numberFormatId:0,numberFormat:null}),value:typeof cell.value==='string'?cell.value.slice(0,300):cell.value,truncated:typeof cell.value==='string'&&cell.value.length>300,formula:cell.formula});
  }
  if(ordinal>=args.offset&&nextOffset===null){const item={row:row.r,cells:out};const bytes=Buffer.byteLength(JSON.stringify(item));if(shownBytes+bytes<=L.previewBytes){items.push(item);shownBytes+=bytes;}else nextOffset=ordinal;}
 }
 // Very wide rows cannot be paged by row offset. Require a narrower range explicitly.
 if(nextOffset!==null&&!items.length)throw fail('XLSX_PREVIEW_TOO_WIDE');
 if(stats.size>128)throw fail('XLSX_PREVIEW_TOO_WIDE');
 return {checksum:book.checksum,selection:{...sel,matchingRows:matched},coverage:{scannedRows:scanned,matchingRows:matched,displayedRows:items.length,allMatchingRowsAggregated:true,formulaValues:'cached-not-recalculated'},items,nextOffset,
  statistics:[...stats.values()].map(s=>({...s,sum:Number.isFinite(s.sum)?s.sum:null}))};
}
const escape=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\r/g,'&#13;');
function cellXML(cell,ref,value){
 // Keep every original cell attribute except type, and preserve non-value child
 // features by refusing cells with unknown children rather than discarding them.
 const attrs=cell?.attributes||` r="${ref}"`;
 if(value===null)return `<c${attrs}/>`;
 if(typeof value==='string')return `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${escape(value.replace(/_x[0-9a-f]{4}_/gi,s=>'_x005F_'+s.slice(1)).replace(/\r/g,'_x000D_'))}</t></is></c>`;
 return `<c${attrs}${typeof value==='boolean'?' t="b"':''}><v>${typeof value==='boolean'?Number(value):value}</v></c>`;
}
function transform(book,raw,row,sel,ops,formulaRanges){
 const values=cells(book,raw,row.r);if(!matches(values,sel.where))return {xml:raw,matched:0,changed:0,formulaSkipped:0,nonNumericSkipped:0};
 const edits=[];let changed=0,formulaSkipped=0,nonNumericSkipped=0;
 for(const op of ops){const c=policy.column(op.column),cell=values.get(c),old=cell?.value??null;let value=old;
  if(cell?.formula||formulaRanges.some(r=>r.r1<=row.r&&r.r2>=row.r&&r.c1<=c&&r.c2>=c)){formulaSkipped++;continue;}
  if(op.type==='set_value')value=op.value;
  else if(op.type==='replace_text'){if(old!==op.expected)continue;value=op.value;}
  else {if(typeof old!=='number'){nonNumericSkipped++;continue;}value=op.type==='multiply'?old*op.value:roundDecimal(old,op.value);if(!Number.isFinite(value))throw fail('XLSX_NUMERIC_OVERFLOW');}
  if(value===old)continue;
  if(cell){const original=raw.slice(cell.start,cell.end),open=original.slice(0,original.indexOf('>')+1);
   // Namespace prefixes / exotic value children require a future adapter revision.
   if(!/^<c\s/.test(open))throw fail('XLSX_UNSUPPORTED');
   let allowed=true;parse(`<root xmlns="${NS}" ${book.rowNamespaces||""}>${original}</root>`,{open:n=>{if(n.local!=='root'&&(!['c','v','is','t'].includes(n.local)||n.uri!==NS))allowed=false;}});
   if(!allowed)throw fail('XLSX_UNSUPPORTED');
   cell.attributes=open.replace(/^<c/,'').replace(/\/?\s*>$/,'').replace(/\s+t\s*=\s*("[^"]*"|'[^']*')/,'');
   edits.push({start:cell.start,end:cell.end,xml:cellXML(cell,cell.ref,value)});
  }else{
   // Insert missing cells into existing rows, keeping ascending column order.
   const next=[...values.values()].find(v=>v.col>c);let position=next?.start;
   if(position==null){const close=/<\/row\s*>\s*$/.exec(raw);if(!close)throw fail('XLSX_UNSUPPORTED');position=close.index;}
   edits.push({start:position,end:position,column:c,xml:cellXML(null,colName(c)+row.r,value)});
  }
  changed++;
 }
 edits.sort((a,b)=>b.start-a.start||(b.column||0)-(a.column||0));let xml=raw;for(const e of edits)xml=xml.slice(0,e.start)+e.xml+xml.slice(e.end);
 return {xml,matched:1,changed,formulaSkipped,nonNumericSkipped};
}
function prepare(book,args,saved){
 if(book.checksum!==args.sourceChecksum||!saved||saved.sourceChecksum!==book.checksum||saved.id!==args.selectionId)throw fail('XLSX_SOURCE_CHANGED');
 const sheet=sheetData(book,saved.sheet),descriptor={version:saved.version,sourceChecksum:saved.sourceChecksum,sheet:saved.sheet,range:saved.range,where:saved.where};
 if(hash(JSON.stringify(descriptor))!==saved.id||saved.matchingRows!==args.expectedRows)throw fail('XLSX_SELECTION_MISMATCH');
 for(const op of args.operations){const c=policy.column(op.column);if(c<saved.range.c1||c>saved.range.c2)throw fail('XLSX_INVALID_RANGE');
  if(sheet.merges.some(r=>c>=r.c1&&c<=r.c2&&r.r2>=saved.range.r1&&r.r1<=saved.range.r2&&(c!==r.c1||Math.min(r.r2,saved.range.r2)>r.r1)))throw fail('XLSX_MERGED_TARGET');
 }
 return {sheet,selection:saved,rows:sheet.rows.filter(r=>r.r>=saved.range.r1&&r.r<=saved.range.r2)};
}
function* chunks(book,args,saved,cursor=0){
 const {sheet,selection:sel,rows}=prepare(book,args,saved);if(!Number.isInteger(cursor)||cursor<0||cursor>rows.length)throw fail('DOCUMENT_CHECKPOINT_INVALID');
 let chunk={cursor,processed:cursor,total:rows.length,start:0,end:0,xml:'',matched:0,changed:0,formulaSkipped:0,nonNumericSkipped:0},count=0;
 for(let i=cursor;i<rows.length;i++){
  const row=rows[i],r=transform(book,sheet.xml.slice(row.start,row.end),row,sel,args.operations,sheet.formulaRanges);
  if(Buffer.byteLength(r.xml)>L.chunkBytes)throw fail('XLSX_ROW_TOO_LARGE');
  const gap=count?sheet.xml.slice(chunk.end,row.start):'';
  if(count&&(count>=L.rowsPerChunk||Buffer.byteLength(chunk.xml)+Buffer.byteLength(gap)+Buffer.byteLength(r.xml)>L.chunkBytes)){
   yield chunk;chunk={cursor:i,processed:i,total:rows.length,start:0,end:0,xml:'',matched:0,changed:0,formulaSkipped:0,nonNumericSkipped:0};count=0;
  }
  if(!count)chunk.start=row.start;else chunk.xml+=sheet.xml.slice(chunk.end,row.start);
  chunk.xml+=r.xml;chunk.end=row.end;chunk.processed=i+1;count++;for(const k of ['matched','changed','formulaSkipped','nonNumericSkipped'])chunk[k]+=r[k];
 }
 if(count)yield chunk;
}
async function assemble(book,args,saved,records){
 const {sheet,rows}=prepare(book,args,saved);let cursor=0,end=0,out='',totals={matched:0,changed:0,formulaSkipped:0,nonNumericSkipped:0};
 for(const c of records){if(c.cursor!==cursor||c.processed<=cursor||c.processed>rows.length||c.start!==rows[cursor].start||c.end!==rows[c.processed-1].end||c.hash!==hash(c.xml))throw fail('DOCUMENT_CHECKPOINT_INVALID');
  out+=sheet.xml.slice(end,c.start)+c.xml;end=c.end;cursor=c.processed;for(const k of Object.keys(totals))totals[k]+=c[k];
 }if(cursor!==rows.length||totals.matched!==args.expectedRows)throw fail('XLSX_SELECTION_MISMATCH');out+=sheet.xml.slice(end);
 parse(out);const parts=new Map(book.parts);parts.set(sheet.path,Buffer.from(out));
 // Formula caches remain untouched, and Excel must recalculate dependents on open.
 let workbook=xmlOf(parts,'xl/workbook.xml');
 if(!/<workbook\b/.test(workbook))throw fail('XLSX_UNSUPPORTED');
 const calc='<calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/>';
 if(/<calcPr\b/.test(workbook))workbook=workbook.replace(/<calcPr\b[^>]*>/,tag=>tag.replace(/\s+(?:calcId|fullCalcOnLoad|forceFullCalc)\s*=\s*(?:"[^"]*"|'[^']*')/g,'').replace(/(\/?)>$/,' calcId="0" fullCalcOnLoad="1" forceFullCalc="1"$1>'));
 else {const later=/<(?:oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b/.exec(workbook);const at=later?.index??workbook.lastIndexOf('</workbook>');if(at<0)throw fail('XLSX_UNSUPPORTED');workbook=workbook.slice(0,at)+calc+workbook.slice(at);}
 parts.set('xl/workbook.xml',Buffer.from(workbook));
 const zip=new(require('jszip'))();for(const [name,b]of parts)zip.file(name,b,{createFolders:false});
 const buffer=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}});
 if(buffer.length>require('../files/config').maxBytes())throw fail('COMPUTE_OUTPUT_LIMIT');
 // Reopen the final container; verify untouched part bytes and the exact edited XML.
 const verified=load(buffer);if(!verified.parts.get(sheet.path)?.equals(parts.get(sheet.path)))throw fail('XLSX_VERIFICATION_FAILED');
 for(const [name,b]of book.parts)if(name!==sheet.path&&name!=='xl/workbook.xml'&&!verified.parts.get(name)?.equals(b))throw fail('XLSX_VERIFICATION_FAILED');
 return {buffer,report:{version:1,sourceChecksum:book.checksum,resultChecksum:hash(buffer),sheet:saved.sheet,...totals,processedRows:rows.length,chunks:records.length,
  otherPartsByteIdentical:true,formulaCellsPreserved:true,formulaValuesRecalculated:false,recalculateOnOpen:true,structuralChecksPassed:true}};
}
module.exports={load,inspect,prepare,chunks,assemble,hash,cells,sheetData,selection};
