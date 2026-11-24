const test = require('node:test');
const assert = require('node:assert/strict');
const reading = require('../../src/services/files/ocrReading');
const ocr = require('../../src/services/files/ocrInput');
const paged = require('../../src/services/files/ocrPaged');
const store = require('../../src/services/files/store');
const exact = require('../../src/services/files/exactTranscription');
const zip = require('../../src/services/files/zipInput');
const router = require('../../src/routes/files');
const { unknown } = reading;

test('visually distinct prefix, two corroborating reads and identical numeric suffix', () => {
  const word = {text:'ОА-217', confidence:91};
  const value = (a,b,shape) => reading.identifier(word,a,b,()=>shape);
  assert.equal(value('QA-217','QA-217','Q'),'QA-217');
  assert.equal(value('QA-217','QA-217','O'),'ОА-217');
  for (const result of [value('QA-217','QA-217',null),value('QA-217','QA-271','Q'),
    value('QA-218','QA-218','Q'),value('QA-217',undefined,'Q')]) assert.equal(result,unknown);
});

test('region conflict masks disputed text but preserves matching figures and order', () => {
  const body = 'Дата 07.11.2026\nТовар 760,18 грн\nПорожньо';
  const region = {line:2,original:'Товар 760,18 грн',alternative:'Товар 7606,18 грн',numericAgreement:false};
  assert.equal(reading.regions(body,[region]),'Дата 07.11.2026\nТовар '+unknown+' грн\nПорожньо');
  const confirmed = {line:2,original:region.original,alternative:'Папір 760,18 грн',numericAgreement:true,
    recognitionIncomplete:false,crossCheck:{status:'agreement',readings:Array.from({length:2},()=>({
      text:'Папір 760,18 грн',numericAgreement:true,recognitionIncomplete:false}))}};
  assert.equal(reading.regions(body,[confirmed]),body.replace('Товар','Папір'));
  assert.equal(reading.regions('Назва\nТовар\n760,18 грн',[{...confirmed,line:2,sourceLines:[2,3],original:'Товар\n760,18 грн'}]).trimEnd(),'Назва\nПапір 760,18 грн');
  confirmed.crossCheck.readings[1].recognitionIncomplete = true;
  assert.equal(reading.regions(body,[confirmed]),body.replace('Товар',unknown));
  confirmed.crossCheck.readings={length:2};
  assert.equal(reading.regions(body,[confirmed]),body.replace('Товар',unknown));
});

test('old cache serves the same single reading to preview, TXT, model context and exact transcription',async t=>{
  const id = '123456789012345678901234';
  const layer = '\n[PDF PAGE 2 OF 2 — TEXT LAYER]\nОА-217 literal';
  const oldText = '[PDF PAGE 1 OF 2 — OCR]\nОА-217 760,18\n[OCR IDENTIFIER ALTERNATIVES — unverified]\n{"original":"ОА-217","latin":"QA-217"}'+layer;
  const expected = '[PDF PAGE 1 OF 2 — OCR]\n'+unknown+' 760,18'+layer;
  const file={_id:id,originalName:'scan.pdf',mimetype:'application/pdf',checksum:'x',
    ocrCache:{version:3,qualityRevision:3,checksum:'x',text:oldText,pages:1}};
  t.mock.method(store,'owned',async()=>file);
  const before=process.env.PRIVATE_FILES_ENABLED; process.env.PRIVATE_FILES_ENABLED='true';
  t.after(()=>{if(before===undefined)delete process.env.PRIVATE_FILES_ENABLED;else process.env.PRIVATE_FILES_ENABLED=before;});
  assert.equal(ocr.fresh(file),false);
  assert.equal(paged.valid({revision:1,checksum:'x',languages:'auto'},file,'auto'),false);
  const part=await ocr.readPart('owner',file);
  assert.equal(JSON.parse(part.text.split('\n')[1]).content,expected);
  const files=await exact.candidates('owner',[{role:'user',attachments:[{...file,fileId:id,storage:'private'}]}],{});
  assert.equal(files[0].text,expected);
  assert.ok((await exact.render('owner',{ids:[id]},files)).includes(expected));
  const handler=router.stack.find(s=>s.route?.path==='/:id/ocr').route.stack[0].handle;
  for(const download of [false,true]){
    let output;
    await handler({user:{_id:'owner'},params:{id},query:download?{download:'1'}:{}},
      {set(){return this;},send(v){output=v.toString();},json(v){output=v.text;}},e=>{throw e;});
    assert.equal(output,expected);
  }
  assert.equal(file.ocrCache.text,oldText);
  file.zipCache={version:1,checksum:'x',kinds:['ocr','text'],text:JSON.stringify({entries:[
    {path:'scan.pdf',content:oldText},{path:'example.txt',content:oldText}]})};
  assert.equal(zip.cached(file),true); assert.equal(zip.fresh(file),false);
  const archive=await zip.readPart('owner',file);
  const entries=JSON.parse(JSON.parse(archive.text.split('\n')[1]).content).entries;
  assert.equal(entries[0].content,expected);
  assert.equal(entries[1].content,oldText);
});

test('an unreadable printed glyph yields the public marker even with two identical OCR guesses', () => {
  const {createCanvas}=require('@napi-rs/canvas');
  const canvas=createCanvas(100,30);
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,100,30);
  ctx.fillStyle='#111';ctx.fillRect(4,5,14,18);
  const word={left:4,top:5,width:48,height:18,text:'ОА-317',confidence:99};
  const glyph=require('../../src/services/files/ocrGlyphs').reader(canvas);
  assert.equal(reading.identifier(word,'QA-317','QA-317',glyph),unknown);
});

test('regional rereads share unused final-page time without extending the overall deadline',()=>{
  const {budget}=require('../../src/services/files/ocrRegions');
  assert.equal(budget(0,8000,1,10000),0);
  assert.equal(budget(0,8000,0,10000),6000);
  assert.equal(budget(0,8000,0,500),500);
  assert.equal(budget(0,14000,0,10000),0);
  assert.equal(budget(50500,8000,0,10000),0);
});
