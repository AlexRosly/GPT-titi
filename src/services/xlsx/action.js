const policy=require('./policy'),store=require('../files/store'),{fail}=require('../files/validation');
async function run({turn,token,model,call,available,signal,completionAllowed}){
 if(!policy.enabled(model))throw fail('XLSX_EDIT_DISABLED');
 const args=policy.parse(call.function.name,call.function.arguments),prior=turn.computeState.files||[];
 if(!available.some(f=>f.fileId===args.fileId)&&!prior.some(f=>f.fileId===args.fileId))throw fail('COMPUTE_FILE_FORBIDDEN');
 const file=await store.owned(turn.user,args.fileId);if(!/\.xlsx$/i.test(file.originalName)||file.size>policy.limits.inputBytes)throw fail('XLSX_FILE_LIMIT');
 if(call.function.name==='edit_xlsx'){
  if(!completionAllowed)throw fail('XLSX_TERMINAL_ACTION_REQUIRED');
  const selection=turn.computeState.xlsxSelections?.[args.selectionId];
  if(!selection||selection.fileId!==args.fileId||selection.sourceChecksum!==args.sourceChecksum||file.checksum!==args.sourceChecksum)throw fail('XLSX_INSPECTION_REQUIRED');
  if(args.filename.normalize('NFC').toLowerCase()===file.originalName.normalize('NFC').toLowerCase())throw fail('XLSX_NEW_FILENAME_REQUIRED');
  if(selection.matchingRows!==args.expectedRows)throw fail('XLSX_SELECTION_MISMATCH');
  for(const op of args.operations){const col=policy.column(op.column);if(col<selection.range.c1||col>selection.range.c2)throw fail('XLSX_INVALID_RANGE');}
  signal?.throwIfAborted();return require('../documentJobs/queue').enqueue({turn,token,args,selection});
 }
 const {buffer}=await store.read(turn.user,args.fileId);
 const computeLimits=require('../computation/policy').limits();
 const remainingMs=computeLimits.totalMs-(turn.computeState.executionMs||0);
 if(remainingMs<=0)throw fail('COMPUTE_RUN_LIMIT');
 const {inspection}=await require('./process').run(buffer,'inspect',args,{signal,timeoutMs:Math.min(60000,computeLimits.runMs,remainingMs)});
 const selections={...turn.computeState.xlsxSelections};
 if(inspection.selection){if(Object.keys(selections).length>=20&&!selections[inspection.selection.id])throw fail('XLSX_SELECTION_LIMIT');
  selections[inspection.selection.id]={...inspection.selection,fileId:args.fileId,scannedRows:inspection.coverage.scannedRows};}
 return {result:{ok:true,text:JSON.stringify(inspection),truncated:inspection.nextOffset!=null},prepared:[],statePatch:{xlsxSelections:selections}};
}
module.exports={run};
