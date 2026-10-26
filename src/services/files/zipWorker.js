const {parentPort,workerData}=require('node:worker_threads');
try {const codec=require('./zipCodec');parentPort.postMessage(workerData.action==='write'?{buffer:codec.write(workerData.entries.map(e=>({...e,buffer:Buffer.from(e.buffer)})))}:{entries:codec.read(Buffer.from(workerData.buffer))});}
catch(error){parentPort.postMessage({error:error.fileError||'INVALID_ZIP'});}
