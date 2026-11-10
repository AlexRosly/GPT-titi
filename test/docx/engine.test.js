const test=require('node:test'),assert=require('node:assert/strict');
const JSZip=require('jszip');
const engine=require('../../src/services/docx/engine');
const policy=require('../../src/services/docx/policy');
const office=require('../../src/services/files/officeInput');
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const id='012345678901234567890123';
const {fixture,table,border,p}=require('./fixtures');
test('signature extension keeps original text, widths, sections and all other ZIP parts',async()=>{
 const b=await fixture(table),d=engine.load(b),outline=engine.inspect(d,'document',0),detail=engine.inspect(d,'table0',0);
 assert.equal(outline.items[0].id,'table0');assert.equal(detail.items[0].cells[1].borders[0].side,'bottom');
 const r=await engine.edit(d,[border('cell0'),border('cell2')]),v=engine.load(r.buffer);
 for(const [name,bytes] of d.parts)if(name!=='word/document.xml')assert.deepEqual(v.parts.get(name),bytes);
 const before=await office.extract(b,'docx'),after=await office.extract(r.buffer,'docx');assert.equal(after,before);
 assert.match(v.xml,/<w:tcW w:w="1000"\/>/);assert.match(v.xml,/<w:pgSz w:w="16838" w:h="11906"\/>/);
 assert.equal(engine.inspect(v,'table0',0).items[0].cells.filter(c=>c.borders.some(b=>b.side==='bottom')).length,3);
 assert.equal((v.xml.match(/xmlns:w=/g)||[]).length,1);
 assert.equal(r.report.visualVerification,false);assert.equal(engine.hash(b),d.checksum);
});
test('existing border modification preserves adjacent border and unrelated cell properties',async()=>{
 const d=engine.load(await fixture(table.replace('<w:tcBorders>','<w:tcBorders><w:top w:val="double"/>')));
 const r=await engine.edit(d,[{...border('cell1'),style:'double',size:8,color:'00FF00'}]);
 assert.match(engine.load(r.buffer).xml,/<w:top w:val="double"\/>/);
});
test('merged and nested tables expose physical cells, spans and stable IDs',async()=>{
 const d=engine.load(await fixture(`<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr>${p('日本語')}${table}</w:tc></w:tr></w:tbl>`));
 const r=engine.inspect(d,'table0',0);assert.equal(r.items[0].cells.length,1);assert.equal(r.items[0].cells[0].gridSpan,'2');assert.equal(r.items[0].cells[0].verticalMerge,'restart');
 const combined=engine.inspect(d,'table0,table1',0);assert.equal(combined.items.length,2);
 const edited=await engine.edit(d,[border('cell1')]);assert.match(engine.load(edited.buffer).xml,/w:gridSpan w:val="2"/);
});
test('precise text node replacement preserves run formatting, escaped text and multilingual content',async()=>{
 const d=engine.load(await fixture('<w:p><w:pPr><w:spacing w:after="20"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="default">Ім’я</w:t></w:r><w:r><w:t> 中文 العربية</w:t></w:r></w:p>'));
 const nodes=engine.inspect(d,'p0',0);assert.equal(nodes.items[0].text,'Ім’я');
 const r=await engine.edit(d,[{type:'replace_text',target:'text0',expected:'Ім’я',value:' A & B < C '}]);
 const v=engine.load(r.buffer);assert.equal(v.byId.get('text0').text,' A & B < C ');assert.match(v.xml,/xml:space="preserve"/);assert.equal(v.byId.get('text1').text,' 中文 العربية');assert.match(v.xml,/<w:rPr><w:b\/><\/w:rPr>/);
});
test('alignment keeps text and spacing; self-closing properties and namespace aliases work',async()=>{
 const b=await fixture('<w:p><w:pPr/><w:r><w:t>Γειά</w:t></w:r></w:p>');
 const z=await JSZip.loadAsync(b);z.file('word/document.xml','\ufeff'+(await z.file('word/document.xml').async('string')).replaceAll('w:', 'a:').replace('xmlns:w=', 'xmlns:a='));
 const d=engine.load(await z.generateAsync({type:'nodebuffer'}));
 const r=await engine.edit(d,[{type:'paragraph_alignment',target:'p0',value:'center'}]);assert.equal(engine.load(r.buffer).byId.get('p0').text,'Γειά');assert.match(engine.load(r.buffer).xml,/a:val="center"/);assert.ok(engine.load(r.buffer).xml.startsWith('\ufeff'));
});
test('duplicates, overlapping changes, missing targets and stale exact text are refused',async()=>{
 const d=engine.load(await fixture(table));
 await assert.rejects(engine.edit(d,[border('cell0'),border('cell0')]),{fileError:'DOCX_DUPLICATE_OPERATION'});
 await assert.rejects(engine.edit(d,[border('cell0'),{type:'replace_text',target:'text0',expected:'Посада',value:'New'}]),{fileError:'DOCX_OVERLAPPING_OPERATIONS'});
 await assert.rejects(engine.edit(d,[border('cell999')]),{fileError:'DOCX_TARGET_NOT_FOUND'});
 await assert.rejects(engine.edit(d,[{type:'replace_text',target:'text0',expected:'Wrong',value:'New'}]),{fileError:'DOCX_TEXT_MISMATCH'});
});
test('tracked changes, signatures, macros, DTDs, protected documents and external templates fail closed',async()=>{
 for(const extra of [
  {'_xmlsignatures/sig1.xml':'<signature/>'},
  {'word/vbaProject.bin':Buffer.from('x')},
  {'word/settings.xml':`<w:settings xmlns:w="${W}"><w:documentProtection/></w:settings>`},
  {'word/_rels/document.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="x/attachedTemplate" Target="https://example.org" TargetMode="External"/></Relationships>'},
  {'word/custom.xml':'<!DOCTYPE a [<!ENTITY x "bad">]><a>&x;</a>'},
 ]) {const b=await fixture(p('x'),extra);assert.throws(()=>engine.load(b));}
 assert.throws(()=>engine.load(Buffer.alloc(5*1024**2+1)),{fileError:'DOCX_EDIT_FILE_LIMIT'});
 const tracked=await fixture(`<w:ins>${p('x')}</w:ins>`);assert.throws(()=>engine.load(tracked),{fileError:'DOCX_EDIT_UNSUPPORTED'});
});
test('tool schema rejects unsupported and injectable properties before mutation',()=>{
 const good={fileId:id,sourceChecksum:'a'.repeat(64),filename:'edited.docx',operations:[border('cell0')]};
 assert.equal(policy.parse('edit_docx',JSON.stringify(good)).operations.length,1);
 for(const operations of [[{...border('cell0'),color:'"/><bad>'}],[{...border('cell0'),size:999}],[{type:'replace_text',target:'text0',expected:'a',value:'\u0000'}]])assert.throws(()=>policy.parse('edit_docx',JSON.stringify({...good,operations})));
 assert.throws(()=>policy.parse('edit_docx',JSON.stringify({...good,filename:'../bad.docx'})));
 assert.throws(()=>policy.parse('edit_docx',JSON.stringify({...good,operations:[]})));
});
test('inspection paginates and reports omitted content rather than implying full coverage',async()=>{
 const d=engine.load(await fixture(Array.from({length:45},(_,i)=>p('Text '+i)).join('')));
 const r=engine.inspect(d,'document',0);assert.equal(r.items.length,20);assert.equal(r.nextOffset,20);assert.equal(r.total,45);
 const last=engine.inspect(d,'document',40);assert.equal(last.items.length,5);assert.equal(last.nextOffset,null);
});

test('tables index avoids spending the action budget paging through unrelated paragraphs',async()=>{
 const d=engine.load(await fixture(Array.from({length:80},()=>p('Context')).join('')+table));
 const r=engine.inspect(d,'tables',0);assert.equal(r.items.length,1);assert.equal(r.items[0].id,'table0');assert.equal(r.nextOffset,null);
 assert.equal(policy.parse('inspect_docx',JSON.stringify({fileId:id,target:'tables',offset:0})).target,'tables');
});
