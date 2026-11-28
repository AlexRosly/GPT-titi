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
function creationManifest() {
  const amount = value => ({type:'number', value, numberFormat:'0.00'});
  const calculated = formula => ({type:'formula', formula, numberFormat:'0.00'});
  return {sheets:[
    {name:'Дані', rows:[
      ['Позиція','Кількість','Ціна','Сума'],
      ['Папка',2,amount(10.25),calculated('=ROUND(B2*C2,2)')],
      ['Зошит',3,amount(4.5),calculated('=ROUND(B3*C3,2)')],
    ]},
    {name:'Підсумок', rows:[['Показник','Сума'],['Разом',calculated("=SUM('Дані'!D2:D3)")]]},
  ]};
}
module.exports={fixture,creationManifest};
