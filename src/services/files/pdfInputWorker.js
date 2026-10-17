const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const { fail } = require('./validation');
const PAGE_LIMIT = 50;
const TEXT_BYTES = 64 * 1024;
(async () => {
  let task;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + path.sep;
    task = pdfjs.getDocument({
      data: new Uint8Array(workerData.buffer),
      isEvalSupported: false, enableXfa: false, stopAtErrors: true,
      disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
      isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
      cMapUrl: assets + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: assets + 'standard_fonts/', wasmUrl: assets + 'wasm/',
      verbosity: 0,
    });
    // No passwords are requested or tried; even empty-password encryption is refused below.
    let doc;
    try { doc = await task.promise; }
    catch (error) {
      if (error.name === 'PasswordException') throw fail('PDF_PASSWORD_PROTECTED');
      throw error;
    }
    if (await doc.getPermissions() !== null) throw fail('PDF_PASSWORD_PROTECTED');
    if (!Number.isSafeInteger(doc.numPages) || doc.numPages < 1) throw fail('INVALID_PDF_DOCUMENT');
    if (doc.numPages > PAGE_LIMIT) throw fail('PDF_PAGE_LIMIT');
    let output = '', bytes = 0, readable = false;
    const append = text => {
      bytes += Buffer.byteLength(text);
      if (bytes > TEXT_BYTES) throw fail('PDF_EXTRACTED_TEXT_TOO_LARGE');
      output += text;
    };
    append('[PDF text-layer extraction. Page numbers are physical PDF page positions, not printed page labels. Images, scans, diagrams, annotations and form values are not read. Text order follows the PDF and may differ from the visual layout, especially for tables and columns. No OCR is performed. A page with some text may still contain unread scanned content. Never claim unread content was analyzed.]\n');
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      append(`\n[PDF PAGE ${number} OF ${doc.numPages}]\n`);
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      let pageReadable = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            // Discard NUL/control characters, keeping normal text, tabs and line endings.
            const text = item.str.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
            if (/[^\s\uFFFD]/u.test(text)) pageReadable = readable = true;
            append(text + (item.hasEOL ? '\n' : ' '));
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); page.cleanup(); }
      if (!pageReadable) append('[NO EXTRACTABLE TEXT ON THIS PAGE: it may be blank or scanned. OCR is required to read scanned content and is not available yet.]\n');
    }
    if (!readable) throw fail('PDF_OCR_REQUIRED');
    parentPort.postMessage({ text: output });
  } catch (error) {
    parentPort.postMessage({ error: error.fileError || (error.name === 'PasswordException' ? 'PDF_PASSWORD_PROTECTED' : 'INVALID_PDF_DOCUMENT') });
  } finally { if (task) await task.destroy().catch(() => {}); }
})();
