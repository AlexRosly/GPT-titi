// Keep Word XML verbatim. A match addresses a complete body paragraph (also inside
// tables). Never concatenate styled runs into a new run or rewrite another ZIP member.
const sax = require('sax');
const JSZip = require('jszip');
const crypto = require('node:crypto');
const {fail} = require('../files/validation');
const {validate, W} = require('../files/officePackage');
const readZip = require('../files/officeInputZip');
const main = 'word/document.xml';
const limits = {inputBytes:20000000,maxExpanded:96*1024**2,maxPart:48*1024**2,maxEntries:2000,
  maxNodes:1500000,maxParagraphs:400000,unitsPerChunk:500,chunkBytes:2*1024**2,stagingBytes:32*1024**2};
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const id = (checksum,find) => hash(JSON.stringify(['docx-text-v1',checksum,find]));
const xmlEscape = value => value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function requireOk(ok,code) { if(!ok)throw fail(code); }
const protectedTag = new Set(['ins','del','moveFrom','moveTo','documentProtection','trackRevisions','altChunk','subDoc','cellIns','cellDel','cellMerge']);
const special = new Set(['tab','br','cr','sym','drawing','pict','object','fldChar','fldSimple','instrText','sdt','hyperlink','vanish','webHidden','noBreakHyphen','softHyphen','txbxContent']);
function load(buffer,find=null) {
  requireOk(buffer.length>0 && buffer.length<=limits.inputBytes,'DOCX_BATCH_FILE_LIMIT');
  const parts=readZip(buffer,{all:true,...limits});
  validate(parts,'docx',limits.maxNodes);
  for(const [name,bytes] of parts) {
    requireOk(!/_xmlsignatures|vbaProject|activeX|embeddings/i.test(name),'DOCX_BATCH_UNSUPPORTED');
    if(name.endsWith('.rels'))requireOk(!/digital-signature|oleObject|attachedTemplate/i.test(bytes.toString('utf8')),'DOCX_BATCH_UNSUPPORTED');
    if(name==='word/settings.xml') {
      require('../files/officePackage').xml(bytes,{open(n){requireOk(n.uri!==W||!protectedTag.has(n.local),'DOCX_BATCH_UNSUPPORTED');}});
    }
  }
  const xml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(parts.get(main));
  const parser=sax.parser(true,{xmlns:true}), stack=[], matches=[], sample=[];
  let paragraph=null,text=null,total=0,bodies=0,explicitBreaks=0,fieldDepth=0;
  parser.onopentag = n => {
    const local=n.uri===W?n.local:'';
    const parent=stack.at(-1);
    stack.push(local);
    if(stack.length===1)requireOk(local==='document','INVALID_OFFICE_DOCUMENT');
    requireOk(!protectedTag.has(local)&&!local.endsWith('PrChange'),'DOCX_BATCH_UNSUPPORTED');
    if(local==='body'){requireOk(parent==='document'&&++bodies===1,'INVALID_OFFICE_DOCUMENT');}
    if(stack[1]!=='body')return;
    if(local==='fldChar'){
      const kind=Object.values(n.attributes).find(a=>a.uri===W&&a.local==='fldCharType')?.value;
      if(kind==='begin')fieldDepth++;
      if(kind==='end')fieldDepth--;
      requireOk(fieldDepth>=0,'DOCX_BATCH_UNSUPPORTED');
    }
    if(local==='p'){
      requireOk(!paragraph && ++total<=limits.maxParagraphs,'DOCX_BATCH_UNSUPPORTED');
      paragraph={number:total-1,length:0,value:'',runs:0,simple:!fieldDepth && !stack.some(k=>special.has(k))};
    }
    if(!paragraph)return;
    if(local==='pageBreakBefore')explicitBreaks++;
    if(special.has(local))paragraph.simple=false;
    if(local==='t'){
      requireOk(!text,'DOCX_BATCH_UNSUPPORTED');
      paragraph.runs++;
      if(parent!=='r'||n.isSelfClosing)paragraph.simple=false;
      text={start:parser.position,name:n.name};
    }
  };
  parser.ontext=parser.oncdata=value=>{
    if(!text || !paragraph)return;
    paragraph.length+=value.length;
    if(paragraph.value.length<512)paragraph.value+=value.slice(0,512-paragraph.value.length);
  };
  parser.onclosetag=()=>{
    const local=stack.pop();
    if(local==='t'&&text) {
      paragraph.start=text.start;
      paragraph.end=xml.lastIndexOf('</',parser.position-1);
      text=null;
    }
    if(local==='p'&&paragraph) {
      const p=paragraph;
      if(sample.length<3 && p.value.trim())sample.push(p.value.slice(0,100));
      if(find!==null && p.length===find.length && p.value===find){
        requireOk(p.simple && p.runs===1 && p.end>=p.start && !xml.slice(p.start,p.end).includes('<'),'DOCX_BATCH_COMPLEX_MATCH');
        matches.push([p.number,p.start,p.end]);
      }
      paragraph=null;
    }
  };
  parser.onerror=()=>{throw fail('INVALID_OFFICE_DOCUMENT');};
  parser.write(xml).close();
  requireOk(bodies===1&&total>0&&fieldDepth===0,'DOCX_BATCH_UNSUPPORTED');
  return {parts,xml,total,matches,sample,explicitBreaks,checksum:hash(buffer)};
}
function inspect(doc,find) {
  return {sourceChecksum:doc.checksum,paragraphs:doc.total,pageBreakBeforeElements:doc.explicitBreaks,
    sample:doc.sample, ...(find===null?{}:{matches:doc.matches.length,
      selection:{id:id(doc.checksum,find),find,total:doc.total,matched:doc.matches.length,sourceChecksum:doc.checksum}})};
}
function validatePlan(doc,args,selection) {
  requireOk(selection?.id===args.selectionId && selection.id===id(doc.checksum,selection.find) &&
    args.sourceChecksum===doc.checksum && selection.total===doc.total && selection.sourceChecksum===doc.checksum &&
    selection.matched===doc.matches.length && args.expectedMatches===doc.matches.length && doc.matches.length>0,
    'DOCX_BATCH_SELECTION_MISMATCH');
}
// Lower bound on paragraph index. On restart, skip all already committed work.
function lowerBound(matches,position){
  let lo=0,hi=matches.length;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(matches[mid][0]<position)lo=mid+1;else hi=mid;}
  return lo;
}
function* chunks(doc,args,selection,cursor) {
  validatePlan(doc,args,selection);
  requireOk(Number.isSafeInteger(cursor)&&cursor>=0&&cursor<=doc.total,'DOCUMENT_CHECKPOINT_INVALID');
  const replacement=xmlEscape(args.value);
  let at=lowerBound(doc.matches,cursor);
  while(cursor<doc.total){
    const processed=Math.min(doc.total,cursor+limits.unitsPerChunk);
    const first=at;
    while(at<doc.matches.length && doc.matches[at][0]<processed)at++;
    // Persist a bounded edit list, not a second full copy of every paragraph.
    const xml=JSON.stringify(doc.matches.slice(first,at).map(([,start,end])=>[start,end,replacement]));
    yield {cursor,processed,total:doc.total,xml,matched:at-first,changed:at-first,formulaSkipped:0,nonNumericSkipped:0};
    cursor=processed;
  }
}
async function assemble(doc,args,selection,records) {
  validatePlan(doc,args,selection);
  const replacement=xmlEscape(args.value), pieces=[];
  let cursor=0,offset=0,count=0,outputBytes=doc.parts.get(main).length;
  for(const [index,r] of records.entries()){
    requireOk(r.index===index && r.cursor===cursor && r.processed===Math.min(cursor+limits.unitsPerChunk,doc.total) &&
      cursor<doc.total && r.total===doc.total && hash(r.xml)===r.hash,'DOCUMENT_CHECKPOINT_INVALID');
    const list=JSON.parse(r.xml);
    const stop=lowerBound(doc.matches,r.processed);
    requireOk(Array.isArray(list)&&list.length===stop-count && list.length===r.matched && r.changed===r.matched,'DOCUMENT_CHECKPOINT_INVALID');
    for(const span of list){
      const [,start,end]=doc.matches[count++];
      requireOk(Array.isArray(span)&&span.length===3&&span[0]===start&&span[1]===end&&span[2]===replacement&&start>=offset,'DOCUMENT_CHECKPOINT_INVALID');
      outputBytes+=Buffer.byteLength(span[2])-Buffer.byteLength(doc.xml.slice(start,end));
      requireOk(outputBytes<=limits.maxPart,'DOCX_BATCH_FILE_LIMIT');
      pieces.push(doc.xml.slice(offset,start),span[2]);
      offset=end;
    }
    cursor=r.processed;
  }
  requireOk(cursor===doc.total&&count===doc.matches.length,'DOCUMENT_CHECKPOINT_INVALID');
  pieces.push(doc.xml.slice(offset));
  const bytes=Buffer.from(pieces.join(''));
  requireOk(bytes.length<=limits.maxPart,'DOCX_BATCH_FILE_LIMIT');
  const zip=new JSZip();
  for(const [name,data] of doc.parts)zip.file(name,name===main?bytes:data,{createFolders:false});
  const buffer=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  requireOk(buffer.length<=limits.inputBytes,'DOCX_BATCH_FILE_LIMIT');
  const out=readZip(buffer,{all:true,...limits});
  requireOk(out.size===doc.parts.size && [...doc.parts].every(([k,v])=>out.get(k)?.equals(k===main?bytes:v)),'DOCX_BATCH_VERIFICATION_FAILED');
  return {buffer,report:{structuralChecksPassed:true,visualVerification:false,processedParagraphs:cursor,matched:count,changed:count,
    chunks:records.length,sourceChecksum:doc.checksum,resultChecksum:hash(buffer)}};
}
module.exports={load,inspect,chunks,assemble,limits,hash,id};
