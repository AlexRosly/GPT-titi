const {parentPort, workerData} = require('node:worker_threads');
const codec = require('./zipCodec');

try {
  if (workerData.action === 'write') {
    const entries = workerData.entries.map(e => ({...e, buffer:Buffer.from(e.buffer)}));
    parentPort.postMessage({buffer:codec.write(entries)});
  } else {
    const data = workerData.buffer;
    const zip = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    // Stored entries may be views into the entire archive. Give each parser
    // only its file's bytes and transfer ownership without cloning the result.
    const entries = codec.read(zip).map(entry => ({
      path:entry.path,
      buffer:Uint8Array.from(entry.buffer),
    }));
    parentPort.postMessage({entries}, entries.map(entry => entry.buffer.buffer));
  }
} catch (error) {
  parentPort.postMessage({error:error.fileError || 'INVALID_ZIP'});
}
