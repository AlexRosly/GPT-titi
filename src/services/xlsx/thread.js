const {parentPort,workerData}=require('node:worker_threads');
const engine=require('./engine');
let ack;
parentPort.on('message',m=>{if(m.type==='ack'&&ack){const resolve=ack;ack=null;resolve();}});
(async()=>{
 const book=engine.load(Buffer.from(workerData.buffer));
 if(workerData.action==='inspect')return {inspection:engine.inspect(book,workerData.args)};
 if(workerData.action==='assemble')return engine.assemble(book,workerData.args,workerData.selection,workerData.records);
 if(workerData.action!=='chunks')throw Error('Unknown adapter action');
 for(const chunk of engine.chunks(book,workerData.args,workerData.selection,workerData.cursor)){
  // Backpressure: at most one unsaved chunk exists in the parser worker.
  const wait=new Promise(resolve=>{ack=resolve;});parentPort.postMessage({type:'chunk',chunk:{...chunk,hash:engine.hash(chunk.xml)}});await wait;
 }
 return {done:true};
})().then(value=>parentPort.postMessage({type:'done',value})).catch(e=>parentPort.postMessage({type:'error',code:e.fileError||'XLSX_INVALID_DOCUMENT'}));
