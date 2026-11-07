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
test('Latin fragmentation may receive only labelled layout alternatives; manual mode remains unchanged',async()=>{
 const old=process.env.OCR_REGIONS_ENABLED,lang=process.env.OCR_LANGUAGES;
 try{process.env.OCR_REGIONS_ENABLED='true';process.env.OCR_LANGUAGES='auto';const b=fs.readFileSync(path.join(root,'international/latin.png'));const r=await extract(b,'image');assert.ok(values(r.text).every(v=>v.script==='Latin'&&v.sourceLines.length>1));
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
test('real OCR recovers truncated Japanese/Korean edges and fragmented English rows without editing primary TSV text',async()=>{
 const os=require('node:os'),cp=require('node:child_process');
 const actual=cp.execFileSync('which',['tesseract'],{encoding:'utf8'}).trim();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ocr-bounds-test-')),oldPath=process.env.PATH;
 try{
 const wrapper='#!'+process.execPath+'\n'+
 'const r=require("node:child_process").spawnSync('+JSON.stringify(actual)+',process.argv.slice(2),{encoding:"utf8"});\n'+
 'let out=r.stdout||"";if(process.argv[2].endsWith("/page.png")&&out.startsWith("level\\t")){out=out.split("\\n").filter(row=>{const f=row.split("\\t");if(f[0]!=="5")return true;const x=Number(f[6]),y=Number(f[7]);return !(y>850&&y<950&&x>1100)&&!(y>1000&&y<1100&&x<400)});const first=out.filter(row=>{const f=row.split("\\t");return f[0]==="5"&&Number(f[7])<500&&f[11]==="English:"});const rest=out.filter(row=>!first.includes(row));out=[rest[0],...first,...rest.slice(1)].join("\\n");}\n'+
 'process.stdout.write(out);process.stderr.write(r.stderr||"");process.exit(r.status??1);\n';
 fs.writeFileSync(path.join(dir,'tesseract'),wrapper,{mode:0o700});process.env.PATH=dir+path.delimiter+oldPath;
 const r=await compare('truncated-primary',fs.readFileSync(path.join(root,'regions/east-asian.png')));
 const japanese=values(r.text).find(v=>v.script==='Japanese'),korean=values(r.text).find(v=>v.script==='Korean');
 assert.ok(japanese);assert.ok(korean);
 const english=values(r.text).filter(v=>v.script==='Latin'&&v.sourceLines.length>1);assert.equal(english.length,6);
 assert.ok(english.every(v=>v.alternative==='English: Document recognition keeps page order and numbers.'));
 assert.match(japanese.alternative.replace(/\s/g,''),/確認してください。$/);
 assert.match(korean.alternative.replace(/\s/g,''),/^이문서는한국어/);
 assert.equal(japanese.boundsStatus,'pixel-region');assert.equal(korean.boundsStatus,'pixel-region');
 assert.equal(japanese.recognitionIncomplete,false);assert.equal(korean.recognitionIncomplete,false);
 assert.ok(japanese.box[0]+japanese.box[2]>1400);assert.ok(korean.box[0]<100);
 }finally{process.env.PATH=oldPath;fs.rmSync(dir,{recursive:true,force:true});}
});

test('original server Han pixels pass PSM 13 without changing models or lowering confidence',()=>{
 const cp=require('node:child_process'),crypto=require('node:crypto');
 const regions=require('../../src/services/files/ocrRegions'),quality=require('../../src/services/files/ocrQuality'),language=require('../../src/services/files/ocrLanguages');
 const input=path.join(root,'regions/han-server-original.png');
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'),'d822722a688bca6a5712362e69883562606100902f844dd99cc05d1751bd12cc');
 const env={...process.env,OMP_THREAD_LIMIT:'1',...(process.env.OCR_TESSDATA_DIR?{TESSDATA_PREFIX:process.env.OCR_TESSDATA_DIR}:{})};
 const available=language.listModels(cp.execFileSync('tesseract',['--list-langs'],{env,encoding:'utf8',timeout:5000}));
 const chosen=regions.selection({script:'Han',confidence:1.24},available,['Latin']);
 const run=(psm,timeout)=>quality.parseTsv(cp.execFileSync('tesseract',[input,'stdout','-l',chosen.models.join('+'),'--oem','1','--psm',String(psm),'-c','tessedit_create_tsv=1'],{env,encoding:'utf8',timeout,maxBuffer:2*1024*1024,stdio:['ignore','pipe','ignore']}));
 const source={text:'KEPPNIR, AHRJ AAAMRR S731.',confidence:15.869565217391305,line:8,left:0,top:0,right:1705,bottom:128};
 const first=run(7,2000),started=Date.now();
 const verified=regions.verify(source,first,chosen,{state:{attempts:0},remaining:()=>regions.budget(Date.now()-started,Date.now()-started),run});
 assert.ok(verified.value,'same-pixel region must produce a confirmed alternative');
 assert.equal(verified.value.alternative.replace(/\s/g,''),'这是中文测试文件，请阅读订单内容和发票号码731。');
 assert.ok(verified.result.confidence>=85);assert.equal(verified.value.original,source.text);
 // Engines may already pass PSM 7; force only its score to exercise the real
 // PSM 13 subprocess on every supported environment, with unchanged pixels.
 const forced=regions.verify(source,{...first,confidence:79.56},chosen,{state:{attempts:0},remaining:()=>8000,run});
 assert.equal(forced.retry,'accepted');assert.equal(forced.value.psm,13);
 assert.equal(forced.value.alternative.replace(/\s/g,''),'这是中文测试文件，请阅读订单内容和发票号码731。');
});

test('worker exposes a labelled PSM 13 fallback after low-confidence Han; primary stays identical',async()=>{
 const os=require('node:os'),cp=require('node:child_process');
 const actual=cp.execFileSync('which',['tesseract'],{encoding:'utf8'}).trim();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ocr-layout-test-')),oldPath=process.env.PATH;
 try{
 const wrapper='#!'+process.execPath+'\n'+
 'const args=process.argv.slice(2);const r=require("node:child_process").spawnSync('+JSON.stringify(actual)+',args,{encoding:"utf8"});\n'+
 'let out=r.stdout||"";if(args[0].endsWith("/region.png")&&args[args.indexOf("--psm")+1]==="7"&&out.includes("中")&&out.includes("文")){out=out.split("\\n").map(row=>{const f=row.split("\\t");if(f[0]==="5")f[10]="79.56";return f.join("\\t")}).join("\\n");}\n'+
 'process.stdout.write(out);process.stderr.write(r.stderr||"");process.exit(r.status??1);\n';
 fs.writeFileSync(path.join(dir,'tesseract'),wrapper,{mode:0o700});process.env.PATH=dir+path.delimiter+oldPath;
 const r=await compare('psm13-fallback',fs.readFileSync(path.join(root,'regions/east-asian.png')));
 const han=values(r.text).find(v=>v.script==='Han');assert.ok(han);assert.equal(han.psm,13);assert.equal(han.layoutFallback,true);
 assert.equal(han.alternative.replace(/\s/g,''),'这是中文测试文件，请阅读订单内容和发票号码731。');
 assert.ok(r.detections[0].regions.layoutRetries<=2);assert.ok(r.detections[0].regions.layoutRecovered>=1);
 // Optional retry failure must leave the primary successful and expose the
 // incomplete check, not fail the document or invent a Han alternative.
 fs.writeFileSync(path.join(dir,'tesseract'),wrapper.replace('const args=process.argv.slice(2);','const args=process.argv.slice(2);if(args[0].endsWith("/region.png")&&args[args.indexOf("--psm")+1]==="13")process.exit(1);'),{mode:0o700});
 const failed=await compare('psm13-failure',fs.readFileSync(path.join(root,'regions/east-asian.png')));
 assert.equal(values(failed.text).some(v=>v.script==='Han'),false);
 assert.ok(failed.detections[0].regions.reasons.verificationFailed>=1);
 assert.match(failed.text,/OCR REGION CHECK INCOMPLETE/);
 }finally{process.env.PATH=oldPath;fs.rmSync(dir,{recursive:true,force:true});}
});
