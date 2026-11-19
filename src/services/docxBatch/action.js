const policy=require('./policy'),engine=require('./engine');
const {fail}=require('../files/validation');
const store=require('../files/store');
const adapter='docx-text-v1';
async function run({turn,token,model,call,available,signal,completionAllowed}){
  const name=call.function.name;
  if(!policy.enabled(model)||turn.docxQualityPlan)throw fail('DOCX_BATCH_DISABLED');
  const args=policy.parse(name,call.function.arguments);
  if(![...available,...(turn.computeState.files||[])].some(f=>f.fileId===args.fileId))throw fail('COMPUTE_FILE_FORBIDDEN');
  const file=await store.owned(turn.user,args.fileId);
  if(!/\.docx$/i.test(file.originalName)||file.size>engine.limits.inputBytes)throw fail('DOCX_BATCH_FILE_LIMIT');
  signal?.throwIfAborted();
  const saved=turn.computeState.docxBatchSelections||{};
  if(name===policy.editName){
    const selection=saved[args.selectionId];
    if(!completionAllowed)throw fail('DOCX_BATCH_TERMINAL_REQUIRED');
    if(!selection||selection.fileId!==args.fileId||file.checksum!==args.sourceChecksum||
      selection.sourceChecksum!==args.sourceChecksum||selection.matched!==args.expectedMatches||selection.find===args.value)throw fail('DOCX_BATCH_SELECTION_MISMATCH');
    if(args.filename.normalize('NFC').toLowerCase()===file.originalName.normalize('NFC').toLowerCase())throw fail('DOCX_NEW_FILENAME_REQUIRED');
    return require('../documentJobs/queue').enqueue({adapter,turn,token,args,selection});
  }
  const budget=require('../computation/policy').limits();
  const timeoutMs=Math.min(budget.runMs,budget.totalMs-(turn.computeState.executionMs||0));
  if(timeoutMs<=0)throw fail('COMPUTE_RUN_LIMIT');
  const {buffer}=await store.read(turn.user,args.fileId);
  const {inspection}=await require('../documentJobs/process').run(buffer,'inspect',args,{adapter,signal,timeoutMs});
  const selection={...inspection.selection,fileId:args.fileId};
  if(Object.keys(saved).length>=20&&!saved[selection.id])throw fail('DOCX_BATCH_SELECTION_LIMIT');
  return {result:{ok:true,text:JSON.stringify(inspection),truncated:false},prepared:[],
    statePatch:{docxBatchSelections:{...saved,[selection.id]:selection}}};
}
module.exports={run};
