const {ChatTurn}=require('../../models');
const accounting=require('./accounting');const policy=require('./policy');const fileIO=require('./files');
const store=require('../files/store');
const partial=(turn,reason)=>({assistantText:`Calculation stopped (${reason}). Only successfully completed computations and attached files are available; the task may be incomplete.`,usage:turn.computeState.usage,computation:{status:'partial',reason,files:turn.computeState.files||[],runs:turn.computeState.runs,executionMs:turn.computeState.executionMs}});
async function run(turn,token,model,messages,firstCall,usage,available,client,parentSignal){
 if(!usage||![usage.promptTokens,usage.completionTokens,usage.totalTokens].every(n=>Number.isSafeInteger(n)&&n>=0))throw policy.fail('COMPUTE_USAGE_UNKNOWN');
 const l=policy.limits(),deadline=Date.now()+l.durationMs;let release, cleanupUnconfirmed=false;
 const controller=new AbortController(),abort=()=>controller.abort();
 const timer=setTimeout(abort,l.durationMs);parentSignal?.addEventListener('abort',abort,{once:true});if(parentSignal?.aborted)abort();
 const save=async state=>{const r=await ChatTurn.updateOne(accounting.guard(turn,token),{$set:{computeState:state}});if(!r.matchedCount)throw Object.assign(Error('Stale lease'),{staleLease:true});turn.computeState=state;};
 try{
  await save({calls:0,pending:false,usage,initialUsage:usage,runs:0,executionMs:0,files:[],stage:'preparing'});
  if(!policy.enabled(model))throw policy.fail('COMPUTE_DISABLED');
  release=await require('./leases').acquire(turn.user);
  const transcript=messages.map(m=>({...m}));let call=firstCall;
  while(call){
   if(controller.signal.aborted)throw policy.fail('COMPUTE_ABORTED');
   const action=policy.parse(call.function.arguments),state=turn.computeState;
   if(state.runs>=l.runs||state.executionMs>=l.totalMs)throw policy.fail('COMPUTE_RUN_LIMIT');
   if(action.exports.length&&!require('../files/artifacts').outputEnabled(model))throw policy.fail('COMPUTE_OUTPUT_DISABLED');
   // Avoid spending CPU on a loop that cannot afford even the bounded next answer.
   const preview=require('./budget').estimate(transcript,[policy.tool],turn.pricing);
   const extra=accounting.cost({promptTokens:state.usage.promptTokens-usage.promptTokens,completionTokens:state.usage.completionTokens-usage.completionTokens},turn.pricing)*turn.pricing.tokenValueUsd;
   if(extra+preview.usd>l.usd)throw policy.fail('COMPUTE_BUDGET_LIMIT');
   const inputs=await fileIO.inputs(turn,action,available);
   const started=Date.now();await save({...state,runs:state.runs+1,stage:'executing'});
   let result,prepared=[];
   try{
    result=await require('./session').run({code:action.code,files:inputs,exports:action.exports,timeoutMs:Math.min(l.runMs,l.totalMs-state.executionMs)},controller.signal);
    prepared=await fileIO.outputs(result,action,model);
   }catch(e){
    if(e.cleanupUnconfirmed){cleanupUnconfirmed=true;throw e;}
    if(controller.signal.aborted)throw policy.fail('COMPUTE_ABORTED');
    result={ok:false,text:e.fileError||'COMPUTE_EXECUTION_FAILED',exports:[],truncated:false};
   }
   const next={...turn.computeState,executionMs:state.executionMs+Date.now()-started,stage:'computed'};
   // File bytes and their checkpoint commit together; failed validation creates nothing.
   await store.transaction(async session=>{
    const current=await ChatTurn.findOne(accounting.guard(turn,token)).session(session);if(!current)throw Object.assign(Error('Stale lease'),{staleLease:true});
    const replacements=new Set(prepared.map(f=>f.name.normalize('NFC').toLowerCase()));
    const previous=current.computeState.files||[];
    const refs=previous.filter(f=>!replacements.has(f.name.normalize('NFC').toLowerCase()));
    if(refs.length+prepared.length>l.files||refs.reduce((n,f)=>n+f.size,0)+prepared.reduce((n,f)=>n+f.buffer.length,0)>l.outputBytes)throw policy.fail('COMPUTE_OUTPUT_LIMIT');
    for(const old of previous)if(replacements.has(old.name.normalize('NFC').toLowerCase()))await store.remove(turn.user,old.fileId,session);
    for(let i=0;i<prepared.length;i++){
     const f=prepared[i];
     const stored=await store.create({...f,user:turn.user,source:'generated',resultKey:`${turn.turnId}:${turn.attempt}:compute:${next.runs}:${i}`,session});
     // Staged results expire unless finalization attaches them. This also covers crashes.
     await require('../../models/managedFile').updateOne({_id:stored._id},{$set:{expiresAt:new Date(Date.now()+3600000)}},{session});
     refs.push({fileId:String(stored._id),name:stored.originalName,size:stored.size});
    }
    next.files=refs;
    const r=await ChatTurn.updateOne(accounting.guard(turn,token),{$set:{computeState:next}},{session});if(!r.matchedCount)throw Object.assign(Error('Stale lease'),{staleLease:true});
   });
   turn.computeState=next;
   transcript.push({role:'assistant',content:null,tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:JSON.stringify({ok:result.ok,text:result.text,truncated:result.truncated,files:next.files,executionMs:next.executionMs})});
   if(controller.signal.aborted||Date.now()>deadline-1000)throw policy.fail('COMPUTE_TIMEOUT');
   const options=next.runs<l.runs&&next.executionMs<l.totalMs&&next.calls<l.calls-1?{tools:[policy.tool],tool_choice:'auto',parallel_tool_calls:false}:{};
   await accounting.begin(turn,token,transcript,options.tools);
   let response;
   try{response=await client.chat.completions.create({model:turn.modelId,messages:transcript,stream:false,max_completion_tokens:l.outputTokens,...options},{signal:controller.signal,timeout:Math.min(45000,deadline-Date.now())});}
   catch(e){if([400,401,403,404,422,429].includes(e.status))await accounting.rejected(turn,token);throw e;}
   await accounting.received(turn,token,response.usage);
   const choice=response.choices?.[0];
   if(!choice||response.choices.length!==1)throw policy.fail('COMPUTE_INVALID_ACTION');
   if(choice.message?.tool_calls?.length){
    if(!options.tools||choice.finish_reason!=='tool_calls'||choice.message.tool_calls.length!==1||choice.message.tool_calls[0].function?.name!=='run_python')throw policy.fail('COMPUTE_INVALID_ACTION');
    call=choice.message.tool_calls[0];if(typeof call.id!=='string'||!call.id||call.id.length>200)throw policy.fail('COMPUTE_INVALID_ACTION');
   }else{
    const text=choice.message?.content;
    if(typeof text!=='string'||!text)throw policy.fail('COMPUTE_INVALID_RESULT');
    return {assistantText:text+(choice.finish_reason==='length'?'\n\n[Response reached its output limit.]':''),usage:turn.computeState.usage,computation:{status:result.ok?'completed':'partial',files:next.files,runs:next.runs,executionMs:next.executionMs}};
   }
  }
 }catch(e){
  policy.diagnose(e,turn,'agent');
  if(e.staleLease||!turn.computeState||turn.computeState.pending)throw e;
  return partial(turn,e.fileError||e.protocolError?.code||'PROVIDER_UNAVAILABLE');
 }finally{clearTimeout(timer);parentSignal?.removeEventListener('abort',abort);controller.abort();if(release&&!cleanupUnconfirmed)await release().catch(()=>console.warn('COMPUTE_LEASE_RELEASE_FAILED',{turnId:turn.turnId,attempt:turn.attempt}));}
}
module.exports={run,partial};
