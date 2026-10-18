// Run as the same OS user/environment as PM2. No DB or provider requests.
require('dotenv').config();
const { execFileSync } = require('node:child_process');
const { languages } = require('../src/services/files/ocrProcess');
const policy = require('../src/services/files/ocrLanguages');
try {
  if (process.platform !== 'linux') throw new Error('OCR requires Linux.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Use Node >= 22.13.0.');
  require('@napi-rs/canvas');
  const env = { ...process.env, MALLOC_ARENA_MAX: '2', RAYON_NUM_THREADS: '1', UV_THREADPOOL_SIZE: '1', OMP_THREAD_LIMIT: '1', ...(process.env.OCR_TESSDATA_DIR ? { TESSDATA_PREFIX: process.env.OCR_TESSDATA_DIR } : {}) };
  const list = execFileSync('tesseract', ['--list-langs'], { encoding: 'utf8', env, timeout: 5000 });
  const missing = policy.missing(languages(), policy.listModels(list));
  if (missing.length) throw new Error('Install missing Tesseract language/script models: ' + missing.join(', '));
  execFileSync('prlimit', ['--as=1073741824', '--cpu=12', '--', 'pdftoppm', '-v'], { stdio: 'pipe', timeout: 5000 });
  execFileSync('prlimit', ['--as=2147483648', '--core=0', '--', process.execPath, '--max-old-space-size=192', '--disable-wasm-trap-handler', '--v8-pool-size=1', '-e', "require('@napi-rs/canvas'); import('pdfjs-dist/legacy/build/pdf.mjs').catch(()=>process.exit(1))"], { stdio: 'pipe', timeout: 10000, env });
  console.log('OCR dependencies OK; mode: ' + languages() + (languages() === 'auto' ? '; ' + policy.SCRIPTS.length + ' script models + OSD available' : ''));
} catch (error) { console.error('OCR dependency check failed: ' + error.message); process.exitCode = 1; }
