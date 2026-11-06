// Requires the same native OCR tools/models as production. No provider/model API calls.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {extract}=require('../../src/services/files/ocrProcess');
const root=path.join(__dirname,'fixtures');
const marker='[OCR REGION ALTERNATIVES';
const primary=text=>text.split(marker)[0].split('[OCR REGION CHECK INCOMPLETE')[0].trim();
const values=text=>text.split('\n').filter(l=>l.startsWith('{"line":')).map(l=>JSON.parse(l));
async function compare(name,buffer,kind='image',options={}){
 const old=process.env.OCR_REGIONS_ENABLED,lang=process.env.OCR_LANGUAGES;
 try{process.env.OCR_LANGUAGES='auto';process.env.OCR_REGIONS_ENABLED='false';const t=Date.now();const before=await extract(buffer,kind,options);const beforeMs=Date.now()-t;
 process.env.OCR_REGIONS_ENABLED='true';const s=Date.now();const after=await extract(buffer,kind,options);const afterMs=Date.now()-s;
 assert.equal(primary(after.text),primary(before.text),'primary OCR remains byte-identical');
 for(const number of ['02.11.2026','137,50'])assert.ok(primary(after.text).includes(number));
 if(process.env.OCR_TEST_ARTIFACT_DIR){const out=process.env.OCR_TEST_ARTIFACT_DIR;fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,name+'-before.json'),JSON.stringify({...before,elapsedMs:beforeMs},null,2));fs.writeFileSync(path.join(out,name+'-after.json'),JSON.stringify({...after,elapsedMs:afterMs},null,2));}
 return after;
 }finally{if(old===undefined)delete process.env.OCR_REGIONS_ENABLED;else process.env.OCR_REGIONS_ENABLED=old;if(lang===undefined)delete process.env.OCR_LANGUAGES;else process.env.OCR_LANGUAGES=lang;}
}
test('Latin-dominant page exposes independent Cyrillic, Greek, Arabic and Hebrew readings without primary changes',async()=>{
 const r=await compare('west-asian',fs.readFileSync(path.join(root,'regions/west-asian.png')));
 assert.equal(r.detections[0].script,'Latin');const alternatives=values(r.text);
 for(const script of ['Cyrillic','Greek','Arabic','Hebrew'])assert.ok(alternatives.some(a=>a.script===script),script);
 const all=alternatives.map(a=>a.alternative).join('\n');for(const word of ['Київ','Αθήνα','ירושלים','القاهرة'])assert.ok(all.includes(word),word);
 assert.deepEqual(alternatives.map(v=>v.line),[5,6,7,8]);
 assert.match(r.text,/unverified/);
});
test('Devanagari and weak-OSD CJK/Korean candidates receive independently verified, labelled alternatives',async()=>{
 const r=await compare('east-asian',fs.readFileSync(path.join(root,'regions/east-asian.png')));
 assert.ok(values(r.text).some(a=>a.script==='Devanagari'&&a.alternative.includes('हिंदी')));
 for(const script of ['Han','Japanese','Korean'])assert.ok(values(r.text).some(a=>a.script===script&&a.scriptDetectionUncertain),script);
 assert.ok(values(r.text).every(a=>a.models.length<=3));
 if(r.detections[0].regions.incomplete)assert.match(r.text,/OCR REGION CHECK INCOMPLETE/);
 assert.equal(r.detections[0].regions.checked,11);
});
test('real scanned PDF preserves page coordinates and exact primary text',async()=>{
 const PDFDocument=require('pdfkit');
 const bytes=await new Promise(resolve=>{const chunks=[],doc=new PDFDocument({autoFirstPage:false});doc.on('data',x=>chunks.push(x));doc.on('end',()=>resolve(Buffer.concat(chunks)));for(const n of ['west-asian','east-asian']){doc.addPage({size:[950,650]});doc.image(path.join(root,'regions',n+'.png'),0,0,{width:950});}doc.end()});
 if(process.env.OCR_TEST_ARTIFACT_DIR)fs.writeFileSync(path.join(process.env.OCR_TEST_ARTIFACT_DIR,'mixed-2-pages.pdf'),bytes);
 for(const page of [1,2]){const r=await compare('pdf-page-'+page,bytes,'pdf',{page});assert.match(r.text,new RegExp(`PDF PAGE ${page} OF 2`));assert.equal(r.detections[0].page,page);assert.ok(r.detections[0].regions.checked>0);}
});
test('pure Latin and manual language settings do not acquire regional alternatives',async()=>{
 const old=process.env.OCR_REGIONS_ENABLED,lang=process.env.OCR_LANGUAGES;
 try{process.env.OCR_REGIONS_ENABLED='true';process.env.OCR_LANGUAGES='auto';const b=fs.readFileSync(path.join(root,'international/latin.png'));const r=await extract(b,'image');assert.equal(values(r.text).length,0);
 process.env.OCR_LANGUAGES='eng';const manual=await extract(b,'image');assert.equal(manual.detections[0].regions,undefined);
 }finally{if(old===undefined)delete process.env.OCR_REGIONS_ENABLED;else process.env.OCR_REGIONS_ENABLED=old;if(lang===undefined)delete process.env.OCR_LANGUAGES;else process.env.OCR_LANGUAGES=lang;}
});
test('failed optional region processes retain the successful primary extraction and disclose incomplete verification',async()=>{
 const os=require('node:os'),cp=require('node:child_process');
 const actual=cp.execFileSync('which',['tesseract'],{encoding:'utf8'}).trim();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ocr-regions-test-')),oldPath=process.env.PATH;
 try{
 const wrapper='#!'+process.execPath+'\n'+
 'if(process.argv[2].endsWith("/region.png"))process.exit(1);\n'+
 'const r=require("node:child_process").spawnSync('+JSON.stringify(actual)+',process.argv.slice(2),{stdio:"inherit"});process.exit(r.status??1);\n';
 fs.writeFileSync(path.join(dir,'tesseract'),wrapper,{mode:0o700});process.env.PATH=dir+path.delimiter+oldPath;
 const r=await compare('optional-failure',fs.readFileSync(path.join(root,'regions/west-asian.png')));
 assert.equal(values(r.text).length,0);assert.equal(r.detections[0].regions.incomplete,true);assert.ok(r.detections[0].regions.reasons.detection>0);assert.match(r.text,/OCR REGION CHECK INCOMPLETE/);
 }finally{process.env.PATH=oldPath;fs.rmSync(dir,{recursive:true,force:true});}
});
