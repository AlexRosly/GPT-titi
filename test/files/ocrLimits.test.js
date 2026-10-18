const test = require('node:test');
const assert = require('node:assert/strict');
const limits = require('../../src/services/files/ocrLimits');
const PDFDocument = require('pdfkit');
const { createCanvas } = require('@napi-rs/canvas');
const { extract } = require('../../src/services/files/ocrProcess');
process.env.OCR_LANGUAGES = 'eng';
test('A4 raster uses 150 DPI instead of forced 2800-pixel upscaling, with bounded large pages', () => {
  const scale = limits.RENDER_DPI / 72;
  assert.equal(limits.renderSide({width: 595.276*scale, height:841.89*scale}), 1754);
  assert.equal(limits.renderSide({width:841.89*scale, height:595.276*scale}), 1754);
  assert.equal(limits.renderSide({width:200,height:300}), 300);
  assert.equal(limits.renderSide({width:20000,height:30000}), 2800);
  for (const height of [NaN,Infinity,0,-1]) assert.throws(() => limits.renderSide({width:height,height}), {fileError:'INVALID_PDF_DOCUMENT'});
});
test('OCR remains bounded below the HTTP timeout despite longer dense-page recognition', () => {
  assert.ok(limits.RECOGNITION_MS > 10000 && limits.RECOGNITION_MS < limits.JOB_MS);
  assert.ok(limits.JOB_MS < 65000 && limits.CPU_SECONDS * 1000 <= limits.JOB_MS);
});
test('four-page image-only PDF returns every physical page with distinct numbers', async () => {
  const data = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({autoFirstPage:false}), parts=[];
    doc.on('data', chunk => parts.push(chunk)); doc.on('end',()=>resolve(Buffer.concat(parts))); doc.on('error',reject);
    for (let page=1;page<=4;page++) {
      const canvas=createCanvas(1240,1754), ctx=canvas.getContext('2d');
      ctx.fillStyle='white';ctx.fillRect(0,0,1240,1754);ctx.fillStyle='black';ctx.font='26px sans-serif';
      ctx.fillText(`DOCUMENT PAGE ${page} ORDER ${730+page}`,60,80);
      for(let line=0;line<24;line++) ctx.fillText(`Record ${100+line}: quantity 12 price 45.67 total 548.04`,60,150+line*58);
      doc.addPage({size:'A4'});doc.image(canvas.toBuffer('image/png'),0,0,{width:595.28,height:841.89});
    }
    doc.end();
  });
  const result=await extract(data,'pdf');
  assert.equal(result.pages,4); assert.equal(result.detections.length,4);
  for(let page=1;page<=4;page++) {
    const section=result.text.split(`[PDF PAGE ${page} OF 4 — OCR]`)[1]?.split('[PDF PAGE')[0];
    assert.ok(section);assert.match(section,new RegExp(`ORDER ${730+page}`));
  }
});
