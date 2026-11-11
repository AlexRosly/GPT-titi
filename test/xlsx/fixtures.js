const ExcelJS=require('exceljs');
async function fixture(rows=10000){
 const wb=new ExcelJS.Workbook();wb.creator='GPTiti test';
 const sheet=wb.addWorksheet('Дані'),other=wb.addWorksheet('Keep');
 sheet.columns=[{header:'ID',key:'id',width:12},{header:'Amount',key:'amount',width:16},{header:'Group',key:'group',width:20},{header:'Formula',key:'formula',width:16},{header:'Note',key:'note',width:20}];
 for(let i=1;i<=rows;i++)sheet.addRow([i,i+0.125,i===rows?'LAST':'normal',{formula:`B${i+1}*2`,result:(i+0.125)*2},'Зберегти']);
 sheet.getColumn(2).numFmt='0.000';sheet.getCell('B2').font={bold:true,color:{argb:'FF123456'}};
 sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter=`A1:E${rows+1}`;
 other.getCell('A1').value='Не змінювати';other.mergeCells('A1:C1');
 return Buffer.from(await wb.xlsx.writeBuffer());
}
module.exports={fixture};
