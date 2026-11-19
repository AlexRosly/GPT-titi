// Deterministic pagination for scale and restart acceptance. No user documents.
const JSZip=require('jszip');
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const entryDate=new Date(2026,0,1);
const oldText='Очікує перевірки', newText='Перевірено';
async function fixture(pages) {
  const zip=new JSZip(), body=[];
  const file=(name,xml)=>zip.file(name,'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+xml,{date:entryDate,createFolders:false});
  file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  const rel=(target,type)=>'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="'+R+'/'+type+'" Target="'+target+'"/></Relationships>';
  file('_rels/.rels',rel('word/document.xml','officeDocument'));
  file('word/_rels/document.xml.rels',rel('styles.xml','styles'));
  file('word/styles.xml','<w:styles xmlns:w="'+W+'"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="36"/></w:rPr></w:style></w:styles>');
  for(let i=1;i<=pages;i++) {
    body.push('<w:p><w:pPr><w:pStyle w:val="Title"/>'+(i>1?'<w:pageBreakBefore/>':'')+'</w:pPr><w:r><w:t>Реєстр перевірки документів</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Запис QA-'+String(i).padStart(5,'0')+'</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>'+oldText+'</w:t></w:r></w:p>');
  }
  body.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1250" w:bottom="1250" w:left="1400" w:right="1250"/></w:sectPr>');
  file('word/document.xml','<w:document xmlns:w="'+W+'"><w:body>'+body.join('')+'</w:body></w:document>');
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
module.exports={fixture,oldText,newText};
