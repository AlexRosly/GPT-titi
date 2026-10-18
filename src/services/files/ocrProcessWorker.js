const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { fail } = require('./validation');
const imageSize = require('./ocrImageSize');
const [dir, kind, languages] = process.argv.slice(2);
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const clean = value => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
const readable = value => /[^\s\uFFFD]/u.test(value);
const languagePolicy = require('./ocrLanguages');
const limits = require('./ocrLimits');
let available;
const detections = [];
function recognize(buffer, page) {
  if (!available) {
    try {
      available = languagePolicy.listModels(execFileSync('tesseract', ['--list-langs'], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'] }));
      if (languagePolicy.missing(languages, available).length) throw new Error();
    } catch { throw fail('OCR_UNAVAILABLE'); }
  }
  const input = path.join(dir, 'page.png');
  fs.writeFileSync(input, buffer, { mode: 0o600 });
  try {
    let detection = { script: null, confidence: null };
    if (languages === 'auto') {
      const osd = spawnSync('tesseract', [input, 'stdout', '-l', 'osd', '--psm', '0', '-c', 'min_characters_to_try=10'], {
        encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (osd.error?.code === 'ETIMEDOUT') throw fail('OCR_PROCESSING_TIMEOUT');
      if (osd.error) throw fail('OCR_UNAVAILABLE');
      if (osd.status === 0) detection = languagePolicy.parseOsd(osd.stdout);
    }
    const selection = languagePolicy.select(languages, available, detection);
    detections.push({ page, ...selection });
    const run = psm => clean(execFileSync('tesseract', [input, 'stdout', '-l', selection.models.join('+'), '--oem', '1', '--psm', String(psm)], {
      encoding: 'utf8', timeout: limits.RECOGNITION_MS, killSignal: 'SIGKILL', maxBuffer: 65536,
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    }));
    let recognized = run(3);
    const quality = languagePolicy.scriptQuality(selection.script, recognized);
    if (quality.retryLayout) {
      const alternative = run(6);
      if (languagePolicy.scriptQuality(selection.script, alternative).matching > quality.matching) {
        recognized = alternative; selection.uncertain = true; selection.layoutFallback = true;
        Object.assign(detections[detections.length - 1], selection);
      }
    }
    return { text: recognized, selection };
  } catch (error) {
    if (error.fileError) throw error;
    if (error.code === 'ENOBUFS') throw fail('OCR_TEXT_TOO_LARGE');
    if (error.code === 'ETIMEDOUT') throw fail('OCR_PROCESSING_TIMEOUT');
    throw fail('OCR_FAILED');
  } finally { fs.rmSync(input, { force: true }); }
}
(async () => {
  let task;
  try {
    const data = fs.readFileSync(path.join(dir, 'input'));
    let output = '', pages = 0, anyText = false;
    const append = text => {
      if (Buffer.byteLength(output) + Buffer.byteLength(text) > 65536) throw fail('OCR_TEXT_TOO_LARGE');
      output += text;
    };
    const ocr = (buffer, page) => {
      if (++pages > 10) throw fail('OCR_PAGE_LIMIT');
      const { text: value, selection } = recognize(buffer, page);
      if (readable(value)) anyText = true;
      const warning = selection.uncertain ? '[SCRIPT SELECTION UNCERTAIN: OCR used a best-effort script choice. Other scripts or short text may be missed or misread. Tell the user to verify this page.]\n' : '';
      return warning + `[OCR MODELS: ${selection.models.join('+')}; SCRIPT: ${selection.script || 'not determined'}]\n` + (value || '[NO TEXT RECOGNIZED: page may be blank, visual-only, or unreadable. Do not invent its contents.]');
    };
    append('[Extracted document data. OCR can misread names, numbers, handwriting, tables and layout; verify important details against the original. OCR is text recognition, not understanding images. Automatic script selection targets the dominant writing system; secondary scripts on the same page may be missed. Never claim unread content was analyzed.]\n');
    if (kind === 'image') {
      imageSize(data);
      let image;
      try { image = await loadImage(data); } catch { throw fail('OCR_INVALID_IMAGE'); }
      if (image.width * image.height > 16000000) throw fail('OCR_IMAGE_LIMIT');
      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0);
      append('[IMAGE PAGE 1 OF 1 — OCR]\n' + ocr(canvas.toBuffer('image/png'), 1) + '\n');
      // Visual-only images remain valid; the existing vision input is preserved.
    } else {
      if (data.toString('ascii', 0, 5) !== '%PDF-') throw fail('INVALID_PDF_DOCUMENT');
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + path.sep;
      task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, enableXfa: false, stopAtErrors: true,
        disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, isOffscreenCanvasSupported: false,
        isImageDecoderSupported: false,
        cMapUrl: assets + 'cmaps/', cMapPacked: true, standardFontDataUrl: assets + 'standard_fonts/', wasmUrl: assets + 'wasm/', verbosity: 0 });
      const doc = await task.promise;
      if (await doc.getPermissions() !== null) throw fail('PDF_PASSWORD_PROTECTED');
      if (doc.numPages > 50) throw fail('PDF_PAGE_LIMIT');
      append('[PDF page numbers are physical positions, not printed labels. Text-layer pages are not OCRed; images on those pages may remain unread. Annotations are excluded; visible text in scanned forms may be recognized.]\n');
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
        let text = '';
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            for (const item of chunk.value.items) {
              if (typeof item.str === 'string') text += clean(item.str) + (item.hasEOL ? '\n' : ' ');
              if (Buffer.byteLength(text) > 65536) throw fail('OCR_TEXT_TOO_LARGE');
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (readable(text)) { anyText = true; append(`\n[PDF PAGE ${n} OF ${doc.numPages} — TEXT LAYER]\n${text}\n`); }
        else {
          if (pages >= 10) throw fail('OCR_PAGE_LIMIT');
          const prefix = path.join(dir, 'rendered');
          // -scale-to forces a size even with -r: never upscale every A4 page to 2800.
          const side = limits.renderSide(page.getViewport({ scale: limits.RENDER_DPI / 72 }));
          try {
            // Poppler runs under native memory/CPU limits; no remote assets or shell.
            const rendering = spawnSync('prlimit', ['--as=1073741824', '--cpu=12', '--', 'pdftoppm', '-f', String(n), '-l', String(n), '-singlefile', '-r', String(limits.RENDER_DPI), '-scale-to', String(side), '-png', '-hide-annotations', path.join(dir, 'input'), prefix], {
              timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 65536, stdio: ['ignore', 'ignore', 'pipe'],
            });
            if (rendering.error) throw rendering.error;
            if (rendering.status !== 0 || rendering.stderr?.length) throw fail(rendering.status === 127 ? 'OCR_UNAVAILABLE' : 'OCR_FAILED');
            const rendered = fs.readFileSync(prefix + '.png');
            imageSize(rendered);
            append(`\n[PDF PAGE ${n} OF ${doc.numPages} — OCR]\n${ocr(rendered, n)}\n`);
          } catch (error) {
            if (error.fileError) throw error;
            if (error.code === 'ENOENT' || error.status === 127) throw fail('OCR_UNAVAILABLE');
            if (error.code === 'ETIMEDOUT') throw fail('OCR_PROCESSING_TIMEOUT');
            throw fail('OCR_FAILED');
          } finally { fs.rmSync(prefix + '.png', { force: true }); }
        }
        page.cleanup();
      }
      if (!anyText) throw fail('OCR_NO_TEXT');
    }
    process.stdout.write(JSON.stringify({ text: output, pages, detections }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.fileError || (error.name === 'PasswordException' ? 'PDF_PASSWORD_PROTECTED' : kind === 'pdf' ? 'INVALID_PDF_DOCUMENT' : 'OCR_FAILED') }));
  } finally { if (task) await task.destroy().catch(() => {}); }
})();
