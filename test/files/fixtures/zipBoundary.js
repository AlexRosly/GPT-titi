// Real text-layer PDFs in a stored ZIP. A legal PDF comment before startxref
// pads each document so the final archive hits the requested byte boundary.
const JSZip = require('jszip');
const { makePdf } = require('./pdfInput');

async function zipBoundary(bytes, count = 10) {
  const archive = new JSZip();
  const names = Array.from({length:count}, (_,i) => 'form-' + (i+1) + '.pdf');
  // Classic ZIP local header (30), central header (46), and two ASCII names.
  const payload = bytes - 22 - names.reduce((n,s) => n + 76 + 2*s.length, 0);
  for (const [i,name] of names.entries()) {
    const pdf = await makePdf(['Control row ' + (i+1) + ': QA-' + (701+i)]);
    const length = Math.floor(payload/count) + (i < payload%count ? 1 : 0);
    const padding = Buffer.alloc(length-pdf.length, 32);
    padding[0] = 37;
    padding[padding.length-1] = 10;
    const at = pdf.lastIndexOf('startxref');
    archive.file(name, Buffer.concat([pdf.subarray(0,at), padding, pdf.subarray(at)]));
  }
  const output = await archive.generateAsync({type:'nodebuffer', compression:'STORE'});
  if (output.length !== bytes) throw new Error('ZIP fixture missed the requested boundary');
  return output;
}
module.exports = { zipBoundary };
