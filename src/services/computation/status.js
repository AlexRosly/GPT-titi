const count=(v,max)=>Number.isSafeInteger(v)&&v>=0?Math.min(v,max):0;
const result=value=>value?{status:value.status==='completed'?'completed':'partial',runs:count(value.runs,5),executionMs:count(value.executionMs,600000),reason:typeof value.reason==='string'&&/^[A-Z_]{1,64}$/.test(value.reason)?value.reason:null}:null;
const progress=turn=>turn.status==='processing'&&turn.computeState?{stage:turn.computeState.pending?'answering':['preparing','executing','computed'].includes(turn.computeState.stage)?turn.computeState.stage:'preparing',runs:count(turn.computeState.runs,5),calls:count(turn.computeState.calls,6)}:null;
module.exports={result,progress};
