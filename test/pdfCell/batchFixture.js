const cells = [
  {page_number:1, row_key:'QA-102', column:'Дата', old:'13.11.2026', new:'07.11.2026'},
  {page_number:2, row_key:'QA-202', column:'Сума, грн', old:'760,18', new:'7606,18'},
  {page_number:2, row_key:'QA-202', column:'Дата', old:'13.11.2026', new:'09.11.2026'},
];
const prompt = [
  'У прикріпленому PDF внеси такі зміни.',
  'На сторінці 1 у рядку «QA-102» у колонці «Дата» заміни «13.11.2026» на «07.11.2026».',
  'На сторінці 2 у рядку «QA-202» у колонці «Сума, грн» заміни «760,18» на «7606,18».',
  'На сторінці 2 у рядку «QA-202» у колонці «Дата» заміни «13.11.2026» на «09.11.2026».',
  'Поверни копію з назвою QA_PDF_multi_result.pdf.',
].join('\n');
// Independent receipts produced by the PDF worker for these three exact edits.
const report = {pages:2, changedPages:2, changedCells:3, verifiedCells:[
  'e18424591d29d3a2bcbf3811d99ff1259b657985535812d718f6bfff022f1756',
  'da24ad22d87fd9ef8ae01504f7473bc57132cdac8ce3adbfbef13e26a3b6391d',
  '777fe551daadb6f0d669703f214a311ce02d446685a0a22f098fd3bf8a341a27',
]};
module.exports = {cells, prompt, report};
