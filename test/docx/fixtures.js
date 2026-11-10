const JSZip=require('jszip');
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function fixture(body,extra={}){
 const z=new JSZip();
 z.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 z.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 z.file('word/document.xml',`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="16838" w:h="11906"/></w:sectPr></w:body></w:document>`);
 z.file('word/styles.xml',`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="test"/></w:styles>`);
 z.file('word/media/image.png',Buffer.from([0,1,2,255]));
 for(const [name,value] of Object.entries(extra))z.file(name,value);
 return z.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
const p=t=>`<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const table=`<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="3000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="1000"/></w:tcPr>${p('Посада')}</w:tc><w:tc><w:tcPr><w:tcW w:w="3000"/><w:tcBorders><w:bottom w:val="single" w:sz="4" w:color="auto"/></w:tcBorders></w:tcPr>${p('')}</w:tc><w:tc><w:tcPr><w:tcW w:w="2000"/></w:tcPr>${p('姓名 اسم')}</w:tc></w:tr></w:tbl>`;
const border=target=>({type:'cell_border',target,side:'bottom',style:'single',size:4,color:'auto'});
module.exports={fixture,table,border,p};
