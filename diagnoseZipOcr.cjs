// GPTiti read-only QA report. Run from the backend root with the PM2 service account.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = process.cwd();
const app = require('node:module').createRequire(path.join(root, 'package.json'));
const chat = '6b0562955b041b8be78f7db3';
const expectedHash = 'f6c1623a0b04ec106605060bb77704e6488d80c5013645862b897068032c5595';
const cases = [['Лелека-02', '384715'], ['Лелека-04', '869374']];
const report = { conversation: chat };
const selects = projection => ({ projection, maxTimeMS: 10000 });
function classify(text, code) {
  if (typeof text !== 'string') return 'unavailable';
  const pieces = text.match(new RegExp('(?<![0-9])' + [...code].join('[^\\S\\r\\n]*') + '(?![0-9])', 'gu')) || [];
  const found = new Set(pieces);
  if (!found.size) return 'missing';
  if (found.size > 1) return 'multiple_spellings';
  return pieces[0] === code ? 'compact' : 'spaced';
}
function fields(manifest) {
  let entries;
  try { entries = JSON.parse(manifest).entries; } catch {}
  return Object.fromEntries(cases.map(([folder, code]) => {
    const entry = Array.isArray(entries) && entries.find(e => e.path === folder + '/Відомість матеріалів.pdf');
    const line = entry?.content?.split(/\r?\n/u).find(s => /контрольний\s+код/iu.test(s));
    return [folder, classify(line, code)];
  }));
}
function command(bin, args) {
  try { return execFileSync(bin, args, {stdio:['ignore','pipe','ignore'],timeout:5000,encoding:'utf8'}).trim(); }
  catch { return ''; }
}
function configuration() {
  const pids = command('pm2',['pid','gpt-titi-back']).split(/\s+/).filter(p => /^[1-9]\d*$/.test(p));
  report.pm2Pids = pids.map(Number);
  let inherited = null;
  if (pids.length === 1) {
    try {
      const dir = fs.realpathSync('/proc/'+pids[0]+'/cwd');
      report.sameWorkingDirectory = dir === fs.realpathSync(root);
      if (report.sameWorkingDirectory) inherited = Object.fromEntries(fs.readFileSync('/proc/'+pids[0]+'/environ','utf8')
        .split('\0').filter(s => s.includes('=')).map(s => [s.slice(0,s.indexOf('=')), s.slice(s.indexOf('=')+1)]));
    } catch { /* Fall back to the operator environment if process metadata is unavailable. */ }
  }
  const dotenv = app('dotenv');
  const disk = fs.existsSync(path.join(root,'.env')) ? dotenv.parse(fs.readFileSync(path.join(root,'.env'))) : {};
  const env = {...disk, ...(inherited || process.env)};
  report.configurationSource = inherited ? 'PM2 start environment plus current .env' : 'CLI environment plus current .env';
  for (const key of ['OCR_LANGUAGES','OCR_TESSDATA_DIR','OCR_REGIONS_ENABLED','ZIP_INPUT_ENABLED','PRIVATE_FILES_ENABLED',
      'OCR_ENABLED','PDF_INPUT_ENABLED','PATH']) {
    if (env[key] !== undefined) process.env[key] = env[key]; else delete process.env[key];
  }
  return env.MONGO_URI || env.MONGODB_URI;
}
async function inspect(db, ObjectId) {
  const conversation = new ObjectId(chat);
  const turn = await db.collection('chatturns').find({conversation, 'files.0':{$exists:true}},
    selects({user:1,files:1,turnId:1,status:1,assistantMessage:1,createdAt:1,providerStartedAt:1,updatedAt:1,
      'workerRuntime.pid':1,'workerRuntime.loadedAt':1})).sort({createdAt:-1}).limit(1).next();
  if (!turn) return 'turn_not_found';
  report.turn = {id:turn.turnId,status:turn.status,createdAt:turn.createdAt,providerStartedAt:turn.providerStartedAt,
    updatedAt:turn.updatedAt,workerPid:turn.workerRuntime?.pid ?? null,workerLoadedAt:turn.workerRuntime?.loadedAt ?? null};
  const answer = turn.assistantMessage && await db.collection('chatmessages').findOne({
    _id:turn.assistantMessage,conversation,role:'assistant'},selects({content:1}));
  report.storedAnswer = Object.fromEntries(cases.map(([key,c]) => [key,classify(answer?.content,c)]));
  const refs = turn.files.map(f => String(f.fileId||f.id||f._id||'')).filter(id=>/^[a-f0-9]{24}$/i.test(id));
  const file = await db.collection('managedfiles').findOne({_id:{$in:refs.map(id=>new ObjectId(id))},user:turn.user,
    checksum:expectedHash,size:32_000_000},selects({checksum:1,size:1,zipCache:1,updatedAt:1,status:1}));
  if (!file) return 'test_archive_not_found_or_checksum_differs';
  const cache = file.zipCache;
  report.savedCache = {fileId:String(file._id),fileStatus:file.status,fileUpdatedAt:file.updatedAt,
    revision:cache?.ocrQualityRevision ?? null, checksumMatches:cache?.checksum===file.checksum,
    ocrPages:cache?.ocrPages ?? null, hasOcrKind:cache?.kinds?.includes('ocr') ?? null, values:fields(cache?.text)};
  if (file.status !== 'ready') return 'archive_unavailable';
  const chunks = db.collection('filechunks').find({file:file._id}, {...selects({data:1,index:1}),promoteBuffers:true}).sort({index:1});
  let size = 0, index = 0;
  const parts = [];
  for await (const row of chunks) {
    if (row.index !== index++ || !Buffer.isBuffer(row.data) || (size += row.data.length) > file.size) return 'invalid_stored_chunks';
    parts.push(row.data);
  }
  const buffer = Buffer.concat(parts,size);
  if (size !== file.size || crypto.createHash('sha256').update(buffer).digest('hex') !== expectedHash) return 'stored_bytes_mismatch';
  report.archiveChecksumVerified = true;
  const zip = app('./src/services/files/zipInput');
  report.cacheFreshForCodeOnDisk = typeof zip.fresh === 'function' ? zip.fresh(file) : null;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'qa-zip-ocr-report-'));
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = temp; // Also confines the OCR service's transient-file cleanup.
    const output = await zip.extract(buffer, {});
    report.freshLocalOcr = {values:fields(output.text),ocrPages:output.ocrPages};
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    fs.rmSync(temp,{recursive:true,force:true});
  }
  return 'completed';
}
(async () => {
  const uri = configuration();
  report.checkout = command('git',['rev-parse','--short','HEAD']) || null;
  report.revisionOnDisk = app('./src/services/files/ocrReading').revision ?? null;
  report.tesseract = /^tesseract [\w.-]+/m.exec(command('tesseract',['--version']))?.[0] ?? null;
  report.languageMode = app('./src/services/files/ocrProcess').languages();
  if (!uri) { report.status = 'database_configuration_unavailable'; return; }
  const { MongoClient, ObjectId } = app('mongodb');
  const client = new MongoClient(uri,{serverSelectionTimeoutMS:8000});
  try { await client.connect(); report.status = await inspect(client.db(),ObjectId); }
  finally { await client.close(); }
})().catch(e => {
  report.status = 'diagnostic_incomplete';
  const tag = e.fileError || e.code || e.name;
  report.error = /^[A-Z0-9_]{1,80}$/i.test(String(tag)) ? String(tag) : 'ERROR';
}).finally(() => {
  console.log(JSON.stringify(report,null,2));
  if (report.status !== 'completed') process.exitCode = 1;
});
