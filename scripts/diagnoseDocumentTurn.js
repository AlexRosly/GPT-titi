// Read-only operator report. Run from the backend root. No model calls or writes.
const path = require('node:path');
const projectRequire = require('node:module').createRequire(path.join(process.cwd(), 'package.json'));
projectRequire('dotenv').config({ quiet: true });
const { MongoClient, ObjectId } = projectRequire('mongodb');
const args = process.argv.slice(2);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,120}$/.test(value) ? value : null;
const num = value => Number.isFinite(value) ? value : null;
const usage = value => value ? Object.fromEntries(['promptTokens','completionTokens','totalTokens'].map(k=>[k,num(value[k])])) : null;
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
const field = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj?.[k] ?? null]));
async function main() {
  const help = 'Run from the backend root: node scripts/diagnoseDocumentTurn.js --recent-xlsx OR --turn-id UUID OR --conversation-id OBJECT_ID';
  if(args.length===1&&args[0]==='--help'){console.log(help);return;}
  let query, recent = false;
  if(args.length===1&&args[0]==='--recent-xlsx'){
    recent=true;query={createdAt:{$gte:new Date(Date.now()-86400000)},'files.0':{$exists:true}};
  }else if(args.length===2&&args[0]==='--turn-id'&&/^[a-f0-9-]{36}$/i.test(args[1]))query={turnId:args[1]};
  else if(args.length===2&&args[0]==='--conversation-id'&&/^[a-f0-9]{24}$/i.test(args[1]))query={conversation:new ObjectId(args[1])};
  else throw Object.assign(Error(help),{safe:true});
  const uri=process.env.MONGO_URI||process.env.MONGODB_URI;
  if(!uri)throw Object.assign(Error('MONGO_URI or MONGODB_URI is required in the server environment.'),{safe:true});
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
  try{
    await client.connect();const db=client.db();
    const projection={turnId:1,conversation:1,modelId:1,attempt:1,status:1,createdAt:1,updatedAt:1,
      processingStartedAt:1,leaseUntil:1,reservationState:1,reservedAppTokens:1,needsReconciliation:1,providerStartedAt:1,
      providerConfig:1,providerResponseIds:1,'providerResult.usage':1,'providerResult.computation.status':1,
      'providerResult.computation.reason':1,'responseState.pending':1,'responseState.calls':1,'responseState.usage':1,
      'computeState.kind':1,'computeState.stage':1,'computeState.calls':1,'computeState.runs':1,'computeState.pending':1,
      'computeState.executionMs':1,'computeState.usage':1,'computeState.lastActionError':1,'computeState.documentJob.active':1,
      'error.code':1,usage:1,'files.fileId':1,'files._id':1,cancelRequestedAt:1,failureDiagnostic:1};
    const candidates=await db.collection('chatturns').find(query,{projection}).sort({createdAt:-1}).limit(recent?100:10).maxTimeMS(10000).toArray();
    const reports=[];
    for(const turn of candidates){
      const ids=(turn.files||[]).map(f=>String(f.fileId||f._id||'')).filter(v=>/^[a-f0-9]{24}$/i.test(v)).map(v=>new ObjectId(v));
      const files=await db.collection('managedfiles').find({_id:{$in:ids}},{projection:{originalName:1,size:1,status:1,mimetype:1}}).maxTimeMS(10000).toArray();
      if(recent&&!files.some(f=>/\.xlsx$/i.test(f.originalName||'')))continue;
      const jobs=await db.collection('documentjobs').find({turnId:turn.turnId,attempt:turn.attempt},{projection:{status:1,cursor:1,total:1,chunks:1,restarts:1,failures:1,stagedBytes:1,errorCode:1,createdAt:1,updatedAt:1,leaseUntil:1,finishedAt:1}}).limit(2).maxTimeMS(10000).toArray();
      const model=await db.collection('chatmodels').findOne({modelId:turn.modelId},{projection:{_id:0,enabled:1,apiMode:1,reasoningEffort:1,computationEnabled:1,officeInputEnabled:1,fileOutputEnabled:1}});
      const billing=await db.collection('chatbillingledgers').find({turnId:turn.turnId},{projection:{_id:0,appTokensSpent:1,totalTokens:1,createdAt:1}}).limit(3).maxTimeMS(10000).toArray();
      const operations=await db.collection('tokenoperations').aggregate([{$match:{'context.turnId':turn.turnId}},{$group:{_id:'$kind',count:{$sum:1}}}],{maxTimeMS:10000}).toArray();
      const d=turn.failureDiagnostic;
      reports.push({turnId:turn.turnId,conversationId:turn.conversation,modelId:turn.modelId,attempt:turn.attempt,
        ...field(turn,['status','createdAt','updatedAt','processingStartedAt','leaseUntil','reservationState','reservedAppTokens','needsReconciliation','providerStartedAt','cancelRequestedAt']),
        errorCode:code(turn.error?.code),model,providerConfig:field(turn.providerConfig,['apiMode','reasoningEffort']),
        providerResponseIds:(turn.providerResponseIds||[]).slice(0,10).map(id),
        response:turn.responseState?{pending:turn.responseState.pending,calls:turn.responseState.calls,usage:usage(turn.responseState.usage)}:null,
        compute:turn.computeState?{...field(turn.computeState,['kind','stage','calls','runs','pending','executionMs']),usage:usage(turn.computeState.usage),lastActionError:code(turn.computeState.lastActionError),documentJobActive:turn.computeState.documentJob?.active===true}:null,
        savedResult:turn.providerResult?{usage:usage(turn.providerResult.usage),...field(turn.providerResult.computation,['status','reason'])}:null,
        failureDiagnostic:d?{...field(d,['version','at','providerHttpStatus','responsePending','computePending','calls','runs','documentJobActive']),code:code(d.code),providerCode:id(d.providerCode),requestId:id(d.requestId),providerResponseStatus:id(d.providerResponseStatus),incompleteReason:id(d.incompleteReason),stage:id(d.stage),lastActionError:code(d.lastActionError)}:null,
        files:files.map(f=>({size:f.size,status:f.status,xlsx:/\.xlsx$/i.test(f.originalName||''),qaFixture:f.originalName==='GPTiti_QA_10000_rows.xlsx'})),
        jobs,billing,operations});
      if(reports.length===10)break;
    }
    const booleans=Object.fromEntries(['DOCUMENT_JOBS_ENABLED','XLSX_EDIT_ENABLED','COMPUTE_V2_ENABLED','PRIVATE_FILES_ENABLED','OFFICE_INPUT_ENABLED'].map(k=>[k,process.env[k]===undefined?'unset':process.env[k]==='true'?'true':process.env[k]==='false'?'false':'non-boolean']));
    const limits=Object.fromEntries(['COMPUTE_MAX_USD','COMPUTE_MAX_RUNS','COMPUTE_MAX_CALLS','COMPUTE_TOTAL_MS','CHAT_V2_LEASE_MS'].map(k=>[k,process.env[k]===undefined?null:num(Number(process.env[k]))]));
    console.log(JSON.stringify({reportVersion:1,generatedAt:new Date(),readOnly:true,flags:booleans,limits,
      searchedCandidates:candidates.length,reports,note:'A missing failureDiagnostic on an older failed turn is expected. This report makes no model calls and changes no data.'},null,2));
  }finally{await client.close();}
}
main().catch(e=>{console.error(e.safe?e.message:`Diagnostic read failed (${id(e.name)||'ERROR'}). Check the server connection locally; do not share credentials.`);process.exitCode=1;});
