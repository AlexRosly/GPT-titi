const {ChatTurn}=require('../../models');
const accounting=require('./accounting');const policy=require('./policy');
const store=require('../files/store');
const partial=(turn,reason)=>({assistantText:`Calculation stopped (${reason}). Only successfully completed computations and attached files are available; the task may be incomplete.`,usage:turn.computeState.usage,computation:{status:'partial',kind:turn.computeState.kind,reason,files:turn.computeState.files||[],runs:turn.computeState.runs,executionMs:turn.computeState.executionMs}});
async function run(turn,token,model,messages,firstCall,usage,available,client,parentSignal){
 if(!usage||![usage.promptTokens,usage.completionTokens,usage.totalTokens].every(n=>Number.isSafeInteger(n)&&n>=0))throw policy.fail('COMPUTE_USAGE_UNKNOWN');
 const l=policy.limits(),deadline=Date.now()+l.durationMs;let release, cleanupUnconfirmed=false;
 const controller=new AbortController(),abort=()=>controller.abort();
 const timer=setTimeout(abort,l.durationMs);parentSignal?.addEventListener('abort',abort,{once:true});if(parentSignal?.aborted)abort();
 const save=async state=>{const r=await ChatTurn.updateOne(accounting.guard(turn,token),{$set:{computeState:state}});if(!r.matchedCount)throw Object.assign(Error('Stale lease'),{staleLease:true});turn.computeState=state;};
 try{
  await save({...(require('../docx/policy').isTool(firstCall.function?.name)?{kind:'document'}:{}),calls:0,pending:false,usage,initialUsage:usage,runs:0,executionMs:0,files:[],stage:'preparing'});
  if(!policy.enabled(model))throw policy.fail('COMPUTE_DISABLED');
  release=await require('./leases').acquire(turn.user);
  const transcript=messages.map(m=>({...m}));let call=firstCall;
  while(call){
   if(controller.signal.aborted)throw policy.fail('COMPUTE_ABORTED');
   const {result,next}=await require('./execute').run({turn,token,model,call,available,transcript,initialUsage:usage,save,signal:controller.signal});
   transcript.push({role:'assistant',content:null,tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:JSON.stringify({ok:result.ok,text:result.text,truncated:result.truncated,files:next.files,executionMs:next.executionMs})});
   if(controller.signal.aborted||Date.now()>deadline-1000)throw policy.fail('COMPUTE_TIMEOUT');
   const options=next.runs<l.runs&&next.executionMs<l.totalMs&&next.calls<l.calls-1?{tools:policy.toolsFor(model),tool_choice:'auto',parallel_tool_calls:false}:{};
   await accounting.begin(turn,token,transcript,options.tools);
   let response;
   try{response=await client.chat.completions.create({model:turn.modelId,messages:transcript,stream:false,max_completion_tokens:l.outputTokens,...options},{signal:controller.signal,timeout:Math.min(45000,deadline-Date.now())});}
   catch(e){if([400,401,403,404,422,429].includes(e.status))await accounting.rejected(turn,token);throw e;}
   await accounting.received(turn,token,response.usage);
   const choice=response.choices?.[0];
   if(!choice||response.choices.length!==1)throw policy.fail('COMPUTE_INVALID_ACTION');
   if(choice.message?.tool_calls?.length){
    if(!options.tools||choice.finish_reason!=='tool_calls'||choice.message.tool_calls.length!==1||!policy.accepts(choice.message.tool_calls[0].function?.name,model))throw policy.fail('COMPUTE_INVALID_ACTION');
    call=choice.message.tool_calls[0];if(typeof call.id!=='string'||!call.id||call.id.length>200)throw policy.fail('COMPUTE_INVALID_ACTION');
   }else{
    const text=choice.message?.content;
    if(typeof text!=='string'||!text)throw policy.fail('COMPUTE_INVALID_RESULT');
    return {assistantText:text+(choice.finish_reason==='length'?'\n\n[Response reached its output limit.]':''),usage:turn.computeState.usage,computation:{status:result.ok?'completed':'partial',kind:next.kind,reason:next.lastActionError,files:next.files,runs:next.runs,executionMs:next.executionMs}};
   }
  }
 }catch(e){
  if(e.cleanupUnconfirmed)cleanupUnconfirmed=true;
  policy.diagnose(e,turn,'agent');
  if(e.staleLease||!turn.computeState||turn.computeState.pending)throw e;
  return partial(turn,e.fileError||e.protocolError?.code||'PROVIDER_UNAVAILABLE');
 }finally{clearTimeout(timer);parentSignal?.removeEventListener('abort',abort);controller.abort();if(release&&!cleanupUnconfirmed)await release().catch(()=>console.warn('COMPUTE_LEASE_RELEASE_FAILED',{turnId:turn.turnId,attempt:turn.attempt}));}
}
module.exports={run,partial};
