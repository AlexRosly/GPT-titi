// Adapter to the existing V2 computation transaction/checkpoint path.
const policy=require('./policy');
const store=require('../files/store');
const tableText=require('./tableText');
const {fail}=require('../files/validation');
async function run({turn,model,call,available,signal,completionAllowed}){
 if(!policy.enabled(model))throw fail('DOCX_EDIT_DISABLED');
 const args=policy.parse(call.function.name,call.function.arguments);
 if(turn.docxQualityPlan && args.fileId !== turn.docxQualityPlan.sourceFileId)throw fail('DOCX_QUALITY_SOURCE');
 if(turn.docxQualityPlan && call.function.name === policy.NAME_EDIT && (!completionAllowed || !args.complete)){
  throw fail(turn.docxQualityPlan.profile === tableText.profile ? 'DOCX_FINAL_EDIT_REQUIRED' : 'DOCX_SIGNATURE_FINAL_EDIT_REQUIRED');
 }
 const prior=turn.computeState?.files||[];
 if(!available.some(f=>f.fileId===args.fileId)&&!prior.some(f=>f.fileId===args.fileId))throw fail('COMPUTE_FILE_FORBIDDEN');
 const metadata=await store.owned(turn.user,args.fileId);
 if(!/\.docx$/i.test(metadata.originalName)||metadata.size>5*1024**2)throw fail('DOCX_EDIT_FILE_LIMIT');
 signal?.throwIfAborted();
 const {buffer}=await store.read(turn.user,args.fileId);
 if(call.function.name===policy.NAME_EDIT){
  const inspection=turn.computeState?.docxInspections?.[args.fileId];
  if(inspection!==args.sourceChecksum)throw fail('DOCX_INSPECTION_REQUIRED');
  if(turn.docxQualityPlan?.profile === tableText.profile && turn.docxQualityPlan.filename) {
   args.filename=require('../files/validation').safeName(turn.docxQualityPlan.filename);
  }
  if(args.filename.normalize('NFC').toLowerCase()===metadata.originalName.normalize('NFC').toLowerCase())throw fail('DOCX_NEW_FILENAME_REQUIRED');
  const selected=args.operations.filter(o=>o.type==='selection_border');
  if(selected.length){
   args.selections={};
   for(const op of selected){
    const saved=turn.computeState.docxSelections?.[op.selectionId];
    if(!saved||saved.fileId!==args.fileId||saved.sourceChecksum!==args.sourceChecksum)throw fail('DOCX_SELECTION_REQUIRED');
    args.selections[op.selectionId]=saved;
   }
  }
 }
 const limits=require('../computation/policy').limits();
 const started=Date.now();
 const remaining=() => Math.min(limits.runMs,limits.totalMs-(turn.computeState?.executionMs||0))-(Date.now()-started);
 const processDocument=async workerArgs => {
  signal?.throwIfAborted();
  if(remaining()<=0 && turn.docxQualityPlan)throw fail('DOCX_QUALITY_TIMEOUT');
  const output=await require('./process').run(buffer,call.function.name,workerArgs,signal,remaining());
  signal?.throwIfAborted();
  return output;
 };
 const output=call.function.name === policy.NAME_EDIT && turn.docxQualityPlan?.profile === tableText.profile
  ? await tableText.editVerified(turn.docxQualityPlan,args,buffer,processDocument,remaining,signal)
  : await processDocument(args);
 if(output.inspection)return {result:{ok:true,text:JSON.stringify(output.inspection),truncated:false},prepared:[],
  statePatch:{docxInspections:{...turn.computeState.docxInspections,[args.fileId]:output.inspection.checksum},
   docxLastInspection:{version:2,displayed:output.inspection.items.length,matching:output.inspection.total,
    hasMore:output.inspection.nextOffset!==null,sampled:output.inspection.coverage.sampled},
   ...(output.inspection.selection?{docxSelections:{...turn.computeState.docxSelections,
    [output.inspection.selection.id]:{...output.inspection.selection,fileId:args.fileId}}}:{})}};
 const result=Buffer.from(output.buffer);
 if(turn.docxQualityPlan && turn.docxQualityPlan.profile !== tableText.profile){
  const quality=await require('./signatureQuality').verify(turn.docxQualityPlan,buffer,result,signal,remaining());
  signal?.throwIfAborted();
  output.report={...output.report,visualVerification:true,signatureQuality:quality};
 }
 return {result:{ok:true,text:JSON.stringify({verification:{...output.report,operations:undefined,operationCount:output.report.operations.length},filename:args.filename}),truncated:false},
  completed:args.complete===true && output.report.requestedPropertiesVerified===true && output.report.documentXmlOutsideTargetsUnchanged===true && output.report.otherPartsByteIdentical===true,
  prepared:[{name:args.filename,mimetype:require('../files/office').mimes.docx,buffer:result,documentEdit:{sourceFileId:args.fileId,...output.report}}],
  statePatch:{docxEdits:[...(turn.computeState.docxEdits||[]),{sourceFileId:args.fileId,...output.report}]}};
}
module.exports={run};
