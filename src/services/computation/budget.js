const {getEncoding}=require('js-tiktoken');const {limits,fail}=require('./policy');let encodings;
function estimate(messages,tools,pricing){
 const l=limits();encodings||=[getEncoding('cl100k_base'),getEncoding('o200k_base')];
 if(![pricing.inputPerM,pricing.outputPerM,pricing.tokenValueUsd].every(Number.isFinite)||pricing.inputPerM<0||pricing.outputPerM<0||pricing.tokenValueUsd<=0)throw fail('COMPUTE_CONFIGURATION_ERROR');
 let images=0;
 const input=messages.map(m=>({...m,content:Array.isArray(m.content)?m.content.map(p=>{if(p.type==='image_url'){images++;return {type:'image_url'};}return p;}):m.content}));
 const serialized=JSON.stringify({messages:input,tools});if(Buffer.byteLength(serialized)>256*1024)throw fail('COMPUTE_CONTEXT_LIMIT');
 const promptTokens=Math.ceil(Math.max(...encodings.map(e=>e.encode(serialized,[],[]).length))*1.15)+512+messages.length*16+images*32768;
 if(promptTokens+l.outputTokens>65536)throw fail('COMPUTE_CONTEXT_LIMIT');
 const usd=(promptTokens*pricing.inputPerM+l.outputTokens*pricing.outputPerM)/1e6;
 const amount=Math.ceil(usd/pricing.tokenValueUsd);if(!Number.isSafeInteger(amount))throw fail('COMPUTE_CONFIGURATION_ERROR');
 return {promptTokens,outputTokens:l.outputTokens,usd,amount};
}
module.exports={estimate};
