const test=require('node:test'),assert=require('node:assert/strict');
const JSZip=require('jszip');const codec=require('../../src/services/files/zipCodec'),input=require('../../src/services/files/zipInput'),output=require('../../src/services/files/zipOutput'),artifacts=require('../../src/services/files/artifacts');
process.env.PRIVATE_FILES_ENABLED='true';
const zip=async files=>{const z=new JSZip();for(const [name,value]of Object.entries(files))z.file(name,value);return z.generateAsync({type:'nodebuffer',compression:'DEFLATE'});};
test('ZIP roundtrip preserves Unicode paths, empty files and bytes; independently opens in JSZip',async()=>{
 const bytes=codec.write([{path:'звіт/дані.csv',buffer:Buffer.from('ім’я,сума\nОлена,42')},{path:'empty.txt',buffer:Buffer.alloc(0)}]);
 const entries=codec.read(bytes);assert.equal(entries[0].path,'звіт/дані.csv');assert.match(entries[0].buffer.toString(),/Олена/);
 const external=await JSZip.loadAsync(bytes,{checkCRC32:true});assert.equal(await external.file('empty.txt').async('string'),'');
 const streaming=await new JSZip().file('notes.txt','data').generateAsync({type:'nodebuffer',streamFiles:true});assert.equal(codec.read(streaming)[0].buffer.toString(),'data');
});
test('paths, collisions, symlinks, encryption, corruption, ZIP64 and expanded bombs fail closed',async()=>{
 for(const name of ['../x.txt','/x.txt','C:/x.txt','a\\b.txt','a/./b.txt','a//b.txt','NUL.txt'])assert.throws(()=>codec.safePath(name));
 assert.throws(()=>codec.write([{path:'A.txt',buffer:Buffer.from('a')},{path:'a.txt',buffer:Buffer.from('b')}]));
 const valid=await zip({'a.txt':'hello'});const central=valid.indexOf(Buffer.from('504b0102','hex'));
 for(const mutate of [b=>{b.writeUInt16LE(1,6);b.writeUInt16LE(1,central+8);},b=>b.writeUInt32LE(0xa0000000,central+38),b=>b.writeUInt32LE(0xffffffff,central+24),b=>b.writeUInt32LE(0,central+16)]){
 const corrupt=Buffer.from(valid);mutate(corrupt);assert.throws(()=>codec.read(corrupt));}
 const bomb=await zip({'large.txt':Buffer.alloc(6*1024**2)});assert.throws(()=>codec.read(bomb),e=>e.fileError==='ZIP_LIMIT');
});
test('input extracts text/code with paths and rejects nested archives/unsupported content without silent omission',async()=>{
 const result=await input.extract(await zip({'src/app.js':'console.log("not executed")','notes.txt':'Привіт','empty.txt':''}),{});
 assert.match(result.text,/src\/app.js/);assert.match(result.text,/Привіт/);assert.equal(result.entries.length,3);assert.deepEqual(result.kinds,['text']);
 for(const name of ['inside.zip','app.exe','drawing.svg'])await assert.rejects(input.extract(await zip({[name]:'data'}),{}),e=>e.fileError==='ZIP_UNSUPPORTED_ENTRY');
 await assert.rejects(input.extract(await zip({'data.txt':'a'.repeat(65537)}),{}),e=>e.fileError==='TEXT_ATTACHMENT_TOO_LARGE');
 await assert.rejects(input.extract(await zip({'a.txt':'a'.repeat(65536),'b.txt':'b'.repeat(65536)}),{}),e=>e.fileError==='ZIP_TEXT_TOO_LARGE');
});
test('ZIP and contained-format opt-outs are independent and checked before parsing',async()=>{
 const data=await zip({'file.txt':'hello'});
 await assert.rejects(input.extract(data,{zipInputEnabled:false}),e=>e.fileError==='ZIP_INPUT_DISABLED');
 await assert.rejects(input.extract(data,{textInputEnabled:false}),e=>e.fileError==='TEXT_INPUT_DISABLED');
 assert.equal(input.enabled({}),true);assert.equal(output.enabled({}),true);assert.equal(output.enabled({zipOutputEnabled:false}),false);
 assert.doesNotMatch(artifacts.autoToolOptions({zipOutputEnabled:false}).tools[0].function.description,/For a ZIP file/);
});
test('generated archive contains real validated text and Office binaries with bounded manifest preview',async()=>{
 const content=JSON.stringify({files:[{path:'notes/readme.md',content:'# Notes'},{path:'data.json',content:'{"ok":true}'},{path:'report.docx',content:JSON.stringify({title:'Report',blocks:[{type:'paragraph',text:'Привіт'}]})}]});
 const result=await output.render({filename:'results.zip'},content);assert.equal(result.mimetype,'application/zip');assert.equal(result.generatedPreview.entries.length,3);
 const external=await JSZip.loadAsync(result.buffer,{checkCRC32:true});assert.equal(await external.file('data.json').async('string'),'{"ok":true}');
 const doc=await JSZip.loadAsync(await external.file('report.docx').async('nodebuffer'));assert.ok(doc.file('word/document.xml'));
 await assert.rejects(output.render({filename:'bad.zip'},JSON.stringify({files:[{path:'bad.json',content:'not json'}]})),e=>e.fileError==='INVALID_JSON');
 assert.throws(()=>output.manifest(JSON.stringify({files:[{path:'inner.zip',content:'x'}]})));
});
test('ZIP OCR uses existing recognizer and preserves uncertainty; image count is bounded',async t=>{
 const processOcr=require('../../src/services/files/ocrProcess');let calls=0;
 t.mock.method(processOcr,'extract',async()=>{calls++;return {text:'[IMAGE] Ukrainian Україна',pages:1,detections:[{uncertain:true}]};});
 const png=Buffer.from('89504e470d0a1a0a00000000','hex');
 const result=await input.extract(await zip({'scan.png':png}),{});assert.equal(result.uncertain,true);assert.equal(result.ocrPages,1);assert.match(result.text,/Україна/);
 await assert.rejects(input.extract(await zip({'scan.png':png}),{ocrInputEnabled:false}),e=>e.fileError==='OCR_INPUT_DISABLED');assert.equal(calls,1);
 await assert.rejects(input.extract(await zip({'1.png':png,'2.png':png,'3.png':png}),{}),e=>e.fileError==='ZIP_OCR_LIMIT');
});
