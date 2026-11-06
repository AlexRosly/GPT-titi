// Private, transactional page checkpoints. Only a fenced preparation worker writes them.
const store = require('./store');
const File = require('../../models/managedFile');
const Quota = require('../../models/fileQuota');
const config = require('./config');
const engine = require('./ocrProcess');
const { fail } = require('./validation');
const MAX_TEXT = 1024 * 1024;
const revision = 1;
const regions = require('./ocrRegions');
const valid = (progress, file, languages) => progress?.revision === revision && progress.checksum === file.checksum && progress.languages === languages && (progress.regionProfile || 'primary-3') === regions.profile();
const size = value => value ? Buffer.byteLength(JSON.stringify(value)) : 0;
const prepare = async (user, id, options) => {
  if (!options.beforeCommit) throw fail('OCR_NOT_READY',409);
  const { file, buffer } = await store.read(user,id);
  if (file.size > 25000000) throw fail('OCR_FILE_TOO_LARGE',413);
  const languages = engine.languages();
  let progress = valid(file.ocrProgress,file,languages) ? JSON.parse(JSON.stringify(file.ocrProgress)) : null;
  const save = async (next, final) => store.transaction(async session => {
    options.signal?.throwIfAborted();
    await options.beforeCommit(session);
    const latest = await store.owned(user,id,{session});
    if (latest.checksum !== file.checksum) throw fail('FILE_UNAVAILABLE',503);
    const bytes = final ? Buffer.byteLength(final.text) + size(final.detections) : size(next) + (latest.ocrCache ? Buffer.byteLength(latest.ocrCache.text || '') + size(latest.ocrCache.detections) : 0);
    const delta = bytes - (latest.derivedBytes || 0);
    const claim = await Quota.updateOne({_id:user,bytes:{$lte:config.quotaBytes()-delta}},{$inc:{bytes:delta}},{session});
    if (!claim.matchedCount) throw fail('FILE_QUOTA_EXCEEDED',413);
    await File.updateOne({_id:latest._id,user,status:'ready',checksum:file.checksum},{$set:{derivedBytes:bytes,ocrProgress:final?null:next,...(final?{ocrCache:final}:{})}},{session});
  });
  if (!progress) {
    const manifest = await engine.extract(buffer,'pdf',{signal:options.signal,page:'inspect'});
    progress = {revision,regionProfile:regions.profile(),checksum:file.checksum,languages,totalPages:manifest.totalPages,manifest:manifest.manifest,completed:[],attempts:{},failedPage:null};
    await save(progress);
  }
  for (const item of progress.manifest) {
    if (progress.completed.some(p=>p.page===item.page)) continue;
    options.signal?.throwIfAborted();
    // At most three automatic retries per preparation attempt; completed pages are never retried.
    let result;
    for (let attempt=1; attempt<=3; attempt++) {
      progress.failedPage=item.page;
      progress.attempts[item.page]=(progress.attempts[item.page]||0)+1;
      await save(progress);
      try { result=await engine.extract(buffer,'pdf',{signal:options.signal,page:item.page}); break; }
      catch(error) {
        if(options.signal?.aborted) throw error;
        if(!['OCR_FAILED','OCR_PROCESSING_TIMEOUT','OCR_UNAVAILABLE','OCR_PROCESSING_BUSY'].includes(error.fileError)) throw error;
        if(attempt>=3) throw error;
      }
    }
    if(!result) throw fail('OCR_FAILED',422);
    const marker=`[PDF PAGE ${item.page} OF ${progress.totalPages} — `;
    const start=result.text.indexOf(marker);
    if(start<0) throw fail('OCR_FAILED',422);
    const text=result.text.slice(start);
    if(progress.completed.reduce((n,p)=>n+Buffer.byteLength(p.text),Buffer.byteLength(text))>MAX_TEXT) throw fail('OCR_TEXT_TOO_LARGE',413);
    if (!progress.header) progress.header=result.text.slice(0,start);
    progress.completed.push({page:item.page,text,ocrPages:result.pages,detections:result.detections});
    progress.failedPage=null;
    await save(progress);
  }
  const ordered=progress.completed.slice().sort((a,b)=>a.page-b.page);
  if(ordered.length!==progress.totalPages) throw fail('OCR_NOT_READY',409);
  if (ordered.every(p=>p.text.includes('[NO TEXT RECOGNIZED:'))) throw fail('OCR_NO_TEXT',422);
  const final={version:3,qualityRevision:3,regionProfile:progress.regionProfile,checksum:file.checksum,languages,text:(progress.header || '')+ordered.map(p=>p.text).join('\n'),pages:ordered.reduce((n,p)=>n+p.ocrPages,0),detections:ordered.flatMap(p=>p.detections),totalPages:progress.totalPages,pagedRevision:revision};
  if(Buffer.byteLength(final.text)>MAX_TEXT) throw fail('OCR_TEXT_TOO_LARGE',413);
  await save(null,final);
};
module.exports={prepare,valid,MAX_TEXT,revision};
