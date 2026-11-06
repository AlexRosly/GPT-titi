const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { fail } = require('./validation');
const imageSize = require('./ocrImageSize');
const [dir, kind, languages, pageMode] = process.argv.slice(2);
const paged = kind === 'pdf' && Boolean(pageMode);
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const clean = value => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
const readable = value => /[^\s\uFFFD]/u.test(value);
const languagePolicy = require('./ocrLanguages');
const limits = require('./ocrLimits');
const qualityPolicy = require('./ocrQuality');
const identifierPolicy = require('./ocrIdentifiers');
const regionPolicy = require('./ocrRegions');
const regionBounds = require('./ocrRegionBounds');
const startedAt = Date.now();
let retries = 0;
let identifierMs = 0;
let regionMs = 0;
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
  const identifierInput = path.join(dir, 'identifiers.png');
  const regionInput = path.join(dir, 'region.png');
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
    const run = (models, psm, timeout = limits.RECOGNITION_MS, sourcePath = input) => qualityPolicy.parseTsv(execFileSync('tesseract', [sourcePath, 'stdout', '-l', models.join('+'), '--oem', '1', '--psm', String(psm), '-c', 'tessedit_create_tsv=1'], {
      encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    }));
    let recognized = run(selection.models, 3);
    selection.psm = 3;
    const scriptMismatch = languagePolicy.scriptQuality(selection.script, recognized.text).retryLayout;
    const han = languages === 'auto' && (selection.script === 'Han' ||
      (selection.script === 'Japanese' && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(recognized.text)));
    const retryLayout = scriptMismatch || (recognized.singleColumn && (recognized.fragmentation > 0 || recognized.confidence < 80 || recognized.lowFraction > 0.2));
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
    let identifierNotes = '';
    const suspect = languages === 'auto' ? identifierPolicy.candidates(recognized.words) : [];
    if (suspect.length) {
      selection.identifierUncertain = true;
      const timeout = identifierPolicy.budget(Date.now() - startedAt, pagesRemaining, identifierMs);
      selection.identifierCheckIncomplete = suspect.length > identifierPolicy.MAX_WORDS || !timeout;
      if (timeout) {
        const started = Date.now();
        try {
          const source = await loadImage(buffer);
          const selected = suspect.slice(0, identifierPolicy.MAX_WORDS);
          const sheet = createCanvas(2048, selected.length * identifierPolicy.ROW_HEIGHT);
          const ctx = sheet.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sheet.width, sheet.height);
          selected.forEach((word, index) => {
            const x = Math.max(0, word.left - 8), y = Math.max(0, word.top - 8);
            const width = Math.min(source.width - x, word.width + 16), height = Math.min(source.height - y, word.height + 16);
            const scale = Math.min(2, 96 / height, 2000 / width);
            ctx.drawImage(source, x, y, width, height, 16, index * identifierPolicy.ROW_HEIGHT + 16, width * scale, height * scale);
          });
          fs.writeFileSync(identifierInput, sheet.toBuffer('image/png'), { mode: 0o600 });
          const latin = languagePolicy.resolveScript('Latin', available);
          const rejected = {};
          const values = identifierPolicy.alternatives(selected, run([latin], 6, timeout, identifierInput), rejected);
          selection.identifierRejections = rejected;
          identifierNotes = identifierPolicy.note(values);
          selection.identifierAlternatives = values.length;
        } catch {
          // Optional verification must not discard a successful primary extraction.
          selection.identifierCheckIncomplete = true;
        } finally { identifierMs += Date.now() - started; }
      }
    }
    if (selection.identifierCheckIncomplete) identifierNotes += '\n[OCR IDENTIFIER CHECK INCOMPLETE: The bounded verification could not check every ambiguous code. Verify identifiers against the original.]';
    let regionNotes = '';
    if (languages === 'auto' && regionPolicy.enabled()) {
      const boundsStarted = Date.now();
      const source = await loadImage(buffer);
      const scale = Math.min(1,1800/Math.max(source.width,source.height));
      const raster = createCanvas(Math.max(1,Math.round(source.width*scale)),Math.max(1,Math.round(source.height*scale)));
      const rasterCtx = raster.getContext('2d'); rasterCtx.fillStyle='#fff';rasterCtx.fillRect(0,0,raster.width,raster.height);
      rasterCtx.drawImage(source,0,0,raster.width,raster.height);
      let geometry;
      try {
        const pixels=regionBounds.detect(rasterCtx.getImageData(0,0,raster.width,raster.height),source.width,source.height);
        geometry={...regionBounds.match(recognized.lines,pixels.regions),truncated:pixels.truncated};
      } catch { geometry={candidates:[],unmatched:recognized.lines.length,truncated:true}; }
      regionMs += Date.now()-boundsStarted;
      const lines = geometry.candidates;
      const values = [];
      const diagnostics = { profile: 'regions-2', eligible: lines.length, checked: 0, alternatives: 0, incomplete: lines.length > regionPolicy.MAX_REGIONS || geometry.unmatched>0 || geometry.truncated, unmatchedLines:geometry.unmatched, boundsTruncated:geometry.truncated, reasons: {}, detections: [] };
      const reason = code => { diagnostics.reasons[code] = (diagnostics.reasons[code] || 0) + 1; diagnostics.incomplete = true; };
      for (const line of lines.slice(0, regionPolicy.MAX_REGIONS)) {
        const remaining = () => regionPolicy.budget(Date.now()-startedAt, regionMs, pagesRemaining);
        if (!remaining()) { reason('budget'); break; }
        const started = Date.now();
        try {
          const x = Math.max(0, line.left-8), y = Math.max(0, line.top-8);
          const w = Math.min(source.width-x, line.right-line.left+16), h = Math.min(source.height-y, line.bottom-line.top+16);
          if (w <= 0 || h <= 0) { reason('geometry'); continue; }
          const scale = Math.min(2, 96/h, 3000/w);
          const crop = createCanvas(Math.ceil(w*scale)+32, Math.ceil(h*scale)+32);
          const ctx = crop.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,crop.width,crop.height);
          ctx.drawImage(source,x,y,w,h,16,16,w*scale,h*scale);
          fs.writeFileSync(regionInput,crop.toBuffer('image/png'),{mode:0o600});
          const osd = spawnSync('tesseract',[regionInput,'stdout','-l','osd','--psm','0','-c','min_characters_to_try=10'],{
            encoding:'utf8',timeout:Math.max(1,Math.min(1000,regionPolicy.budget(Date.now()-startedAt,regionMs+Date.now()-started,pagesRemaining))),killSignal:'SIGKILL',maxBuffer:65536,stdio:['ignore','pipe','pipe'] });
          diagnostics.checked++;
          if (osd.error || osd.status !== 0) { reason('detection'); continue; }
          const detected = languagePolicy.parseOsd(osd.stdout);
          diagnostics.detections.push({ line: line.line, script: detected.script, confidence: detected.confidence });
          if (!detected.script || detected.confidence === null || detected.confidence <= 0) { reason('uncertainScript'); continue; }
          let chosen = regionPolicy.selection(detected,available,selection.models);
          // A geometrically joined row can also need same-script layout verification.
          if (!chosen && line.sourceLines.length>1) {
            const same=languagePolicy.select('auto',available,detected);
            if(same.script && same.models.every(model=>selection.models.includes(model)))chosen={...same,detectionUncertain:false};
          }
          if (!chosen) continue;
          // Account for the current detection before starting optional recognition.
          const left = regionPolicy.budget(Date.now()-startedAt,regionMs+Date.now()-started,pagesRemaining);
          if (!left) { reason('budget'); break; }
          const result = run(chosen.models,7,Math.min(2000,left),regionInput);
          const value = regionPolicy.alternative(line,result,chosen);
          if (!value) { reason('unconfirmedAlternative'); continue; }
          value.edgeCoverage=regionBounds.edgeCoverage(line,result,{x,scale});
          value.recognitionIncomplete=!value.edgeCoverage.left || !value.edgeCoverage.right;
          if(value.recognitionIncomplete)reason('edgeCoverage');
          if (Buffer.byteLength(regionPolicy.note([...values,value],true)) > regionPolicy.MAX_NOTES_BYTES ||
              Buffer.byteLength(recognized.text+identifierNotes+regionPolicy.note([...values,value],true)) > 60000) { reason('outputLimit'); break; }
          values.push(value);
        } catch { reason('verificationFailed'); }
        finally { regionMs += Date.now()-started; }
      }
      diagnostics.alternatives = values.length;
      diagnostics.elapsedMs = regionMs;
      selection.regions = diagnostics;
      regionNotes = regionPolicy.note(values,diagnostics.incomplete);
    }
    selection.scriptUncertain = scriptUncertain;
    selection.qualityUncertain = recognized.uncertain || Boolean(selection.regions?.alternatives || selection.regions?.incomplete) || Boolean(selection.qualityRetryIncomplete) || Boolean(selection.identifierUncertain);
    selection.uncertain = scriptUncertain || selection.qualityUncertain;
    selection.textConfidence = Math.round(recognized.confidence);
    selection.lowConfidenceFraction = Number(recognized.lowFraction.toFixed(3));
    detections.push({ page, ...selection });
    return { text: recognized.text + identifierNotes + regionNotes, selection };
  } catch (error) {
    if (error.fileError) throw error;
    if (error.code === 'ENOBUFS') throw fail('OCR_TEXT_TOO_LARGE');
    if (error.code === 'ETIMEDOUT') throw fail('OCR_PROCESSING_TIMEOUT');
    throw fail('OCR_FAILED');
  } finally { fs.rmSync(input, { force: true }); fs.rmSync(osdInput, { force: true }); fs.rmSync(identifierInput, { force: true }); fs.rmSync(regionInput, { force: true }); }
}
(async () => {
  let task;
  try {
    const data = fs.readFileSync(path.join(dir, 'input'));
    let output = '', pages = 0, anyText = false;
    let outputParts = [];
    const append = text => {
      const fitted = regionPolicy.fit([...outputParts, text], 65536);
      outputParts = fitted.parts;
      output = outputParts.join('');
      if (Buffer.byteLength(output) > 65536) throw fail('OCR_TEXT_TOO_LARGE');
      if (fitted.omitted) for (const detection of detections) {
        if (detection.regions) { detection.regions.outputOmitted = true; detection.regions.incomplete = true; }
      }
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
      if (doc.numPages > (paged ? 100 : 50)) throw fail('PDF_PAGE_LIMIT');
      const manifest = [];
      append('[PDF page numbers are physical positions, not printed labels. Text-layer pages are not OCRed; images on those pages may remain unread. Annotations are excluded; visible text in scanned forms may be recognized.]\n');
      for (let n = 1; n <= doc.numPages; n++) {
        if (paged && pageMode !== 'inspect' && n !== Number(pageMode)) continue;
        pagesRemaining = paged ? 0 : doc.numPages - n;
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
        if (pageMode === 'inspect') { manifest.push({ page: n, ocr: !readable(text) }); page.cleanup(); continue; }
        if (readable(text)) { anyText = true; append(`\n[PDF PAGE ${n} OF ${doc.numPages} — TEXT LAYER]\n${text}\n`); }
        else {
          if (pages >= 10) throw fail('OCR_PAGE_LIMIT');
          const prefix = path.join(dir, 'rendered');
          // Preserve small print at 300 DPI, still capped at 3600 pixels.
          const side = limits.renderSide(page.getViewport({ scale: limits.RENDER_DPI / 72 }));
          try {
            // Poppler runs under native memory/CPU limits; no remote assets or shell.
            const scaling = side === limits.MAX_RENDER_SIDE ? ['-scale-to', String(side)] : [];
            const rendering = spawnSync('prlimit', ['--as=1073741824', '--cpu=12', '--', 'pdftoppm', '-f', String(n), '-l', String(n), '-singlefile', '-r', String(limits.RENDER_DPI), ...scaling, '-gray', '-png', '-hide-annotations', path.join(dir, 'input'), prefix], {
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
      if (pageMode === 'inspect') {
        if (manifest.filter(p => p.ocr).length > 30) throw fail('OCR_PAGE_LIMIT');
        process.stdout.write(JSON.stringify({ manifest, totalPages: doc.numPages })); return;
      }
      if (!anyText && !paged) throw fail('OCR_NO_TEXT');
    }
    process.stdout.write(JSON.stringify({ text: output, pages, detections }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.fileError || (error.name === 'PasswordException' ? 'PDF_PASSWORD_PROTECTED' : kind === 'pdf' ? 'INVALID_PDF_DOCUMENT' : 'OCR_FAILED') }));
  } finally { if (task) await task.destroy().catch(() => {}); }
})();
