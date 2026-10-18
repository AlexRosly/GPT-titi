// Offline regression check: no database, provider requests or document text in logs.
require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const { extract } = require('../src/services/files/ocrProcess');
(async () => {
  const filename = process.argv[2];
  if (!filename || process.argv.length !== 3) throw new Error('Usage: npm run ocr:file -- /path/to/document.pdf');
  const info = await fs.stat(filename);
  if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error('Expected a file of at most 5 MiB');
  const data = await fs.readFile(filename);
  const start = Date.now();
  const result = await extract(data, data.subarray(0, 5).toString() === '%PDF-' ? 'pdf' : 'image');
  const pages = [...result.text.matchAll(/\[PDF PAGE (\d+) OF (\d+) — (OCR|TEXT LAYER)\]/g)]
    .map(m => ({ page: Number(m[1]), total: Number(m[2]), method: m[3] }));
  console.log(JSON.stringify({ ok: true, durationMs: Date.now() - start, fileBytes: data.length,
    textBytes: Buffer.byteLength(result.text), ocrPages: result.pages, pages,
    detections: result.detections }, null, 2));
})().catch(error => { console.error(JSON.stringify({ ok: false, error: error.fileError || error.message })); process.exitCode = 1; });
