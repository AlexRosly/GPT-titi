const crypto=require('node:crypto');
const Job=require('../../models/documentJob'),Chunk=require('../../models/documentJobChunk'),Quota=require('../../models/fileQuota');
const {ChatTurn,ChatModels,User}=require('../../models');
const store=require('../files/store'),slots=require('./slots'),{fail}=require('../files/validation');
const adapters=require('./adapters');
const leaseError=()=>Object.assign(fail('DOCUMENT_LEASE_LOST'),{staleLease:true});
const guard=(job,token)=>({_id:job._id,status:'running',leaseToken:token,leaseUntil:{$gt:new Date()}});
const turnGuard=job=>({_id:job.turn,attempt:job.attempt,status:'processing','computeState.documentJob.id':String(job._id),providerResult:null,reservationState:'held'});
const progress=job=>({id:String(job._id),active:true,state:job.status==='queued'?'queued':'running',processed:job.cursor,total:job.total,chunks:job.chunks,restarts:job.restarts});
async function enqueue({turn,token,args,selection}){
 return store.transaction(async session=>{
  const current=await ChatTurn.findOne(require('../computation/accounting').guard(turn,token)).session(session);
  if(!current)throw leaseError();
  if(current.computeState?.pending!==false||current.responseState?.pending||!current.computeState.usage||
    !Object.values(current.computeState.usage).every(n=>Number.isSafeInteger(n)&&n>=0))throw fail('COMPUTE_USAGE_UNKNOWN');
  const original=await store.owned(turn.user,args.fileId,{session});if(original.checksum!==args.sourceChecksum)throw fail('XLSX_SOURCE_CHANGED');
  const [job]=await Job.create([{user:turn.user,turn:turn._id,turnId:turn.turnId,attempt:turn.attempt,adapter:'xlsx-v1',sourceFile:args.fileId,
   sourceChecksum:args.sourceChecksum,plan:args,selection,total:selection.scannedRows,deadline:new Date(Date.now()+86400000)}],{session});
  for(const ref of current.computeState.files||[])await require('../../models/managedFile').updateOne({_id:ref.fileId,user:turn.user,status:'ready',retention:'temporary'},{$set:{expiresAt:new Date(job.deadline.getTime()+3600000)}},{session});
  const state={...current.computeState,kind:'document',stage:'executing',lastActionFailed:false,lastActionError:null,documentJob:progress(job)};
  // An active background job is not an expired chat. A finite deadline also
  // keeps legacy recovery scanners from immediately claiming the handed-off turn.
  // Publication makes it eligible for chat finalization by setting epoch below.
  const updated=await ChatTurn.updateOne(require('../computation/accounting').guard(turn,token),{$set:{computeState:state,leaseToken:null,leaseUntil:job.deadline}},{session});
  if(!updated.matchedCount)throw leaseError();turn.computeState=state;
  return {deferred:true,jobId:String(job._id)};
 });
}
async function verify(job,token,keys,session,{allowCancelled=false}={}){
 const current=await ChatTurn.findOne(turnGuard(job)).session(session||null).lean();if(!current)throw fail('DOCUMENT_TURN_GONE');
 if(!await User.exists({_id:job.user,status:'active'}).session(session||null))throw fail('DOCUMENT_TURN_GONE');
 if(current.cancelRequestedAt&&!allowCancelled)throw fail('USER_CANCELLED');
 const r=await Job.updateOne(guard(job,token),{$set:{leaseUntil:new Date(Date.now()+slots.ttl)}},{session});if(!r.matchedCount)throw leaseError();
 await slots.verify(keys,token,session);
 return current;
}
async function checkpoint(job,token,keys,chunk){
 const adapter=adapters.get(job.adapter),L=adapter.limits,bytes=Buffer.byteLength(chunk.xml);
 if(chunk.cursor!==job.cursor||chunk.processed<=chunk.cursor||chunk.processed>chunk.total||chunk.total!==job.total||chunk.processed-chunk.cursor>L.rowsPerChunk||bytes>L.chunkBytes||
  chunk.hash!==adapter.hash(chunk.xml)||job.stagedBytes+bytes>L.stagingBytes)throw fail('DOCUMENT_CHECKPOINT_INVALID');
 let next;
 await store.transaction(async session=>{
  await verify(job,token,keys,session);
  // Write the source metadata in the same transaction: deleting the source races
  // with this guard, and no chunk can commit after an already committed deletion.
  const source=await require('../../models/managedFile').updateOne({_id:job.sourceFile,user:job.user,status:'ready',checksum:job.sourceChecksum,
   $or:[{expiresAt:null},{expiresAt:{$gt:new Date()}}]},{$set:{updatedAt:new Date()}},{session});
  if(!source.matchedCount)throw fail('FILE_NOT_FOUND');
  const quota=await Quota.updateOne({_id:job.user,bytes:{$lte:require('../files/config').quotaBytes()-bytes}},{$inc:{bytes}},{session});
  if(!quota.matchedCount)throw fail('FILE_QUOTA_EXCEEDED');
  await Chunk.create([{job:job._id,index:job.chunks,...chunk,bytes}],{session});
  const sums=Object.fromEntries(['matched','changed','formulaSkipped','nonNumericSkipped'].map(k=>[k,job[k]+chunk[k]]));
  next={...job,...sums,failures:0,cursor:chunk.processed,chunks:job.chunks+1,stagedBytes:job.stagedBytes+bytes};
  const r=await Job.updateOne({...guard(job,token),cursor:chunk.cursor},{$set:{...sums,cursor:next.cursor,chunks:next.chunks,stagedBytes:next.stagedBytes,failures:0}},{session});if(!r.matchedCount)throw leaseError();
  const t=await ChatTurn.updateOne(turnGuard(job),{$set:{'computeState.documentJob':progress(next)}},{session});if(!t.matchedCount)throw leaseError();
 });Object.assign(job,next);
}
async function clean(job,session){
 await Chunk.deleteMany({job:job._id},{session});
 if(job.stagedBytes){const q=await Quota.updateOne({_id:job.user,bytes:{$gte:job.stagedBytes}},{$inc:{bytes:-job.stagedBytes}},{session});if(!q.matchedCount&&await Quota.exists({_id:job.user}).session(session))throw fail('DOCUMENT_QUOTA_INCONSISTENT');}
}
async function publish(job,token,keys,output,errorCode=null){
 await store.transaction(async session=>{
  const current=await verify(job,token,keys,session,{allowCancelled:true});
  // Cancellation wins until this transaction commits the immutable result.
  const reason=current.cancelRequestedAt?'USER_CANCELLED':errorCode||(job.deadline<=new Date()?'DOCUMENT_JOB_EXPIRED':null);
  const saved=await Job.findOne(guard(job,token)).session(session).lean();if(!saved)throw leaseError();
  await clean(saved,session);
  const state={...current.computeState,documentJob:{...progress(saved),active:false,state:reason?'stopped':'completed'}};
  let data,resultFile;
  if(reason){data=require('../computation/agent').partial({...current,computeState:state},reason);}
  else{
   if(!output?.report?.structuralChecksPassed||output.report.sourceChecksum!==job.sourceChecksum||output.report.matched!==job.plan.expectedRows||
    output.report.processedRows!==saved.total||output.report.chunks!==saved.chunks||adapters.get(job.adapter).hash(Buffer.from(output.buffer))!==output.report.resultChecksum)throw fail('XLSX_VERIFICATION_FAILED');
   const source=await require('../../models/managedFile').updateOne({_id:job.sourceFile,user:job.user,status:'ready',checksum:job.sourceChecksum,
    $or:[{expiresAt:null},{expiresAt:{$gt:new Date()}}]},{$set:{updatedAt:new Date()}},{session});if(!source.matchedCount)throw fail('FILE_NOT_FOUND');
   const prepared=Buffer.from(output.buffer),refs=state.files||[],replacements=refs.filter(f=>f.name.normalize('NFC').toLowerCase()===job.plan.filename.normalize('NFC').toLowerCase());
   const keep=refs.filter(f=>!replacements.includes(f)),limits=require('../computation/policy').limits();
   if(keep.length+1>limits.files||keep.reduce((n,f)=>n+f.size,0)+prepared.length>limits.outputBytes)throw fail('COMPUTE_OUTPUT_LIMIT');
   for(const f of replacements)await store.removeTemporary(job.user,f.fileId,session);
   resultFile=await store.create({user:job.user,name:job.plan.filename,mimetype:require('../files/office').mimes.xlsx,buffer:prepared,
    source:'generated',retention:'temporary',resultKey:`${job.turnId}:${job.attempt}:compute:document-job`,documentEdit:{sourceFileId:String(job.sourceFile),...output.report},session});
   state.files=[...keep,{fileId:String(resultFile._id),name:resultFile.originalName,size:resultFile.size}];
   state.documentJob.report=output.report;
   data={assistantText:`Edited Excel copy attached. Processed ${output.report.processedRows} source rows; changed ${output.report.changed} cells. Preserved ${output.report.formulaSkipped} targeted formula cells; skipped ${output.report.nonNumericSkipped} non-numeric or blank cells in numeric operations. Formula values were not recalculated; The workbook is marked for recalculation when opened.`,
    usage:state.usage,computation:{kind:'document',status:'completed',files:state.files,runs:state.runs,executionMs:state.executionMs}};
  }
  const r=await ChatTurn.updateOne(turnGuard(job),{$set:{computeState:state,providerResult:data,leaseToken:null,leaseUntil:new Date(0)}},{session});if(!r.matchedCount)throw leaseError();
  const updated=await Job.updateOne(guard(job,token),{$set:{status:reason?(reason==='USER_CANCELLED'?'cancelled':'failed'):'ready',errorCode:reason,finishedAt:new Date(),stagedBytes:0,
   resultFile:resultFile?._id,leaseToken:null,leaseUntil:null}},{session});if(!updated.matchedCount)throw leaseError();
 });
}
async function abandon(job,token){
 await store.transaction(async session=>{
  const saved=await Job.findOne(guard(job,token)).session(session).lean();if(!saved)throw leaseError();
  // A deleted/finished turn no longer needs a reply, but its staging quota does.
  await clean(saved,session);const r=await Job.updateOne(guard(job,token),{$set:{status:'cancelled',errorCode:'DOCUMENT_TURN_GONE',finishedAt:new Date(),stagedBytes:0,leaseToken:null,leaseUntil:null}},{session});if(!r.matchedCount)throw leaseError();
 });
 console.warn('DOCUMENT_JOB_TURN_GONE',{jobId:String(job._id),turnId:job.turnId,attempt:job.attempt,
  cursor:job.cursor,total:job.total,runtime:require('../chatDeliveryV2/runtime')});
}
const transient=code=>['DOCUMENT_JOB_TIMEOUT','DOCUMENT_WORKER_CRASH','DOCUMENT_JOB_INTERRUPTED'].includes(code);
async function runOnce(){
 await slots.init();const token=crypto.randomUUID(),now=new Date();
 const job=await Job.findOneAndUpdate({$or:[{status:'queued',notBefore:{$lte:now}},{status:'running',leaseUntil:{$lte:now}}]},
  {$set:{status:'running',leaseToken:token,leaseUntil:new Date(Date.now()+slots.ttl)},$inc:{restarts:1}},{sort:{notBefore:1,createdAt:1},new:true}).lean();
 if(!job)return false;let keys,timer,checking=false;const controller=new AbortController();
 try{
  keys=await slots.acquire(job.user,token);
  await verify(job,token,keys);
  if(job.deadline<=new Date())throw fail('DOCUMENT_JOB_EXPIRED');
  const turn=await ChatTurn.findById(job.turn).lean(),model=turn&&await ChatModels.findOne({modelId:turn.modelId,enabled:true}).lean();
  if(!model||model.computationEnabled===false||model.fileOutputEnabled===false||model.officeInputEnabled===false)throw fail('MODEL_NOT_AVAILABLE');
  const {file,buffer}=await store.read(job.user,String(job.sourceFile));if(file.checksum!==job.sourceChecksum)throw fail('XLSX_SOURCE_CHANGED');
  timer=setInterval(async()=>{if(checking)return;checking=true;try{await verify(job,token,keys);}catch(e){controller.abort(e);}finally{checking=false;}},10000);
  const process=adapters.get(job.adapter);
  await process.run(buffer,'chunks',job.plan,{selection:job.selection,cursor:job.cursor,signal:controller.signal,onChunk:chunk=>checkpoint(job,token,keys,chunk)});
  await verify(job,token,keys);
  await store.transaction(async session=>{await verify(job,token,keys,session);await ChatTurn.updateOne(turnGuard(job),{$set:{'computeState.documentJob.state':'finalizing'}},{session});});
  const records=await Chunk.find({job:job._id}).sort({index:1}).lean();
  if(records.length!==job.chunks)throw fail('DOCUMENT_CHECKPOINT_INVALID');
  const output=await process.run(buffer,'assemble',job.plan,{selection:job.selection,records,signal:controller.signal});
  await publish(job,token,keys,output);
 }catch(e){
  if(e.staleLease)return true;
  const code=e.fileError;
  if(code==='DOCUMENT_JOB_BUSY')await Job.updateOne(guard(job,token),{$set:{status:'queued',leaseToken:null,leaseUntil:null,notBefore:new Date(Date.now()+2000)},$inc:{restarts:-1}});
  else if(code==='DOCUMENT_TURN_GONE')await abandon(job,token);
  else if(keys&&(code==='USER_CANCELLED'||code&&!transient(code)||job.failures>=2||job.deadline<=new Date())){
   try{await publish(job,token,keys,null,code||'DOCUMENT_JOB_FAILED');}catch(error){if(!error.staleLease)throw error;}
  }else{
   // No checkpoint rollback and no provider replay. Consecutive failures reset
   // after a committed chunk; the absolute deadline also bounds crash loops.
   await Job.updateOne(guard(job,token),{$set:{status:'queued',leaseToken:null,leaseUntil:null,notBefore:new Date(Date.now()+2000)},$inc:{failures:1}});
   if(!code)console.warn('DOCUMENT_JOB_RETRY',{jobId:String(job._id),turnId:job.turnId});
  }
 }finally{clearInterval(timer);controller.abort();if(keys)await slots.release(keys,token);}
 return true;
}
let timer,running=false;
function start(){if(timer)return;const tick=async()=>{if(running)return;running=true;try{await runOnce();}catch{console.warn('DOCUMENT_JOB_WORKER_RETRY');}finally{running=false;}};
 // Existing jobs drain even with admission disabled after a deployment rollback.
 timer=setInterval(tick,2000);timer.unref();void tick();}
function stop(){clearInterval(timer);timer=null;}
module.exports={enqueue,checkpoint,publish,runOnce,start,stop,progress,guard,transient};
