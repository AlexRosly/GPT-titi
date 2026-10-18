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
const qualityPolicy = require('./ocrQuality');
const startedAt = Date.now();
let retries = 0;
let pagesRemaining = 0;
let available;
const detections = [];
async function recognize(buffer, page) {
  if (!available) {
    try {
      available = languagePolicy.listModels(execFileSync('tesseract', ['--list-langs'], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'ignore'] }));
      if (languagePolicy.missing(languages, available).length) throw new Error();
    } catch { throw fail('OCR_UNAVAILABLE'); }
  }
  const input = path.join(dir, 'page.png');
  const osdInput = path.join(dir, 'script.png');
  fs.writeFileSync(input, buffer, { mode: 0o600 });
  try {
    let detection = { script: null, confidence: null };
    if (languages === 'auto') {
      // Script detection does not need the full small-print raster. Bound its
      // pixel cost separately, keeping the original resolution for actual OCR.
      const source = await loadImage(buffer);
      const ratio = Math.min(1, 1600 / Math.max(source.width, source.height));
      const sample = createCanvas(Math.max(1, Math.round(source.width * ratio)), Math.max(1, Math.round(source.height * ratio)));
      const ctx = sample.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sample.width, sample.height);
      ctx.drawImage(source, 0, 0, sample.width, sample.height);
      fs.writeFileSync(osdInput, sample.toBuffer('image/png'), { mode: 0o600 });
      const osd = spawnSync('tesseract', [osdInput, 'stdout', '-l', 'osd', '--psm', '0', '-c', 'min_characters_to_try=10'], {
        encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (osd.error?.code === 'ETIMEDOUT') throw fail('OCR_PROCESSING_TIMEOUT');
      if (osd.error) throw fail('OCR_UNAVAILABLE');
      if (osd.status === 0) detection = languagePolicy.parseOsd(osd.stdout);
    }
    const selection = languagePolicy.select(languages, available, detection);
    let scriptUncertain = selection.uncertain;
    const run = (models, psm, timeout = limits.RECOGNITION_MS) => qualityPolicy.parseTsv(execFileSync('tesseract', [input, 'stdout', '-l', models.join('+'), '--oem', '1', '--psm', String(psm), '-c', 'tessedit_create_tsv=1'], {
      encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    }));
    let recognized = run(selection.models, 3);
    selection.psm = 3;
    const scriptMismatch = languagePolicy.scriptQuality(selection.script, recognized.text).retryLayout;
    const han = languages === 'auto' && (selection.script === 'Han' ||
      (selection.script === 'Japanese' && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(recognized.text)));
    const retryLayout = scriptMismatch || (recognized.singleColumn && (recognized.confidence < 85 || recognized.lowFraction > 0.12));
    const hanModels = han ? ['HanS', 'HanT'].map(name => languagePolicy.resolveScript(name, available)) : [];
    const hanPsm = recognized.singleColumn ? 6 : 3;
    const candidates = han
      ? (hanPsm !== 3 || hanModels.join('+') !== selection.models.join('+') ? [{ models: hanModels, psm: hanPsm }] : [])
      : retryLayout ? [{ models: selection.models, psm: 6 }] : [];
    if (han) scriptUncertain = true; // Pure Han cannot identify a precise language.
    // At most two extra passes for the whole document; keep time for later pages.
    for (const candidate of candidates) {
      const budget = qualityPolicy.retryBudget(Date.now() - startedAt, pagesRemaining, retries);
      if (!budget) { selection.qualityRetryIncomplete = true; break; }
      retries++;
      try {
        const alternative = run(candidate.models, candidate.psm, budget);
        if (qualityPolicy.preferAlternative(recognized, alternative) ||
            (!han && scriptMismatch && alternative.characters >= recognized.characters * 0.9 &&
             languagePolicy.scriptQuality(selection.script, alternative.text).matching > languagePolicy.scriptQuality(selection.script, recognized.text).matching)) {
          recognized = alternative; selection.models = candidate.models; selection.psm = candidate.psm;
          selection.layoutFallback = !han;
        }
      } catch (error) {
        if (error.code !== 'ETIMEDOUT') throw error;
        selection.qualityRetryIncomplete = true;
      }
    }
    selection.scriptUncertain = scriptUncertain;
    selection.qualityUncertain = recognized.uncertain || Boolean(selection.qualityRetryIncomplete);
    selection.uncertain = scriptUncertain || selection.qualityUncertain;
    selection.textConfidence = Math.round(recognized.confidence);
    selection.lowConfidenceFraction = Number(recognized.lowFraction.toFixed(3));
    detections.push({ page, ...selection });
    return { text: recognized.text, selection };
  } catch (error) {
    if (error.fileError) throw error;
    if (error.code === 'ENOBUFS') throw fail('OCR_TEXT_TOO_LARGE');
    if (error.code === 'ETIMEDOUT') throw fail('OCR_PROCESSING_TIMEOUT');
    throw fail('OCR_FAILED');
  } finally { fs.rmSync(input, { force: true }); fs.rmSync(osdInput, { force: true }); }
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
    const ocr = async (buffer, page) => {
      if (++pages > 10) throw fail('OCR_PAGE_LIMIT');
      const { text: value, selection } = await recognize(buffer, page);
      if (readable(value)) anyText = true;
      const warning = selection.scriptUncertain ? '[SCRIPT SELECTION UNCERTAIN: OCR used a best-effort script choice. Other scripts or short text may be missed or misread. Tell the user to verify this page.]\n' : '';
      const qualityWarning = selection.qualityUncertain ? '[OCR QUALITY UNCERTAIN: Some words or line order may be wrong. Verify names, dates, identifiers, quantities and amounts against the original; never guess or silently correct them.]\n' : '';
      return warning + qualityWarning + `[OCR MODELS: ${selection.models.join('+')}; SCRIPT: ${selection.script || 'not determined'}]\n` + (value || '[NO TEXT RECOGNIZED: page may be blank, visual-only, or unreadable. Do not invent its contents.]');
    };
    append('[Extracted document data. OCR can misread names, numbers, handwriting, tables and layout; verify important details against the original. OCR is text recognition, not understanding images. Automatic script selection targets the dominant writing system; secondary scripts on the same page may be missed. Never claim unread content was analyzed.]\n');
    if (kind === 'image') {
      imageSize(data);
      let image;
      try { image = await loadImage(data); } catch { throw fail('OCR_INVALID_IMAGE'); }
      if (image.width * image.height > 16000000) throw fail('OCR_IMAGE_LIMIT');
      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0);
      append('[IMAGE PAGE 1 OF 1 — OCR]\n' + await ocr(canvas.toBuffer('image/png'), 1) + '\n');
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
        pagesRemaining = doc.numPages - n;
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
          // Preserve small print at 200 DPI, still capped at 2800 pixels.
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
            append(`\n[PDF PAGE ${n} OF ${doc.numPages} — OCR]\n${await ocr(rendered, n)}\n`);
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
