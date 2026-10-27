const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
const {fail}=require('./policy');
function cleanPng(b) {
 const {crc32}=require('../files/zipCodec');const kept=[b.subarray(0,8)],data=[];let pos=8,ended=false,count=0;
 while(pos<b.length){
  if(pos+12>b.length||++count>10000)throw Error('PNG chunks');
  const size=b.readUInt32BE(pos),end=pos+12+size;if(end>b.length)throw Error('PNG length');
  const type=b.toString('ascii',pos+4,pos+8);
  if(!/^[A-Za-z]{4}$/.test(type)||(pos===8&&type!=='IHDR')||(type==='IHDR'&&(pos!==8||size!==13))||(type==='PLTE'&&(size>768||data.length))||(type==='tRNS'&&(size>256||data.length)))throw Error('PNG structure');
  if(crc32(b.subarray(pos+4,end-4))!==b.readUInt32BE(end-4))throw Error('PNG CRC');
  if(['IHDR','PLTE','tRNS','IDAT','IEND'].includes(type))kept.push(b.subarray(pos,end));
  else if(type[0]===type[0].toUpperCase())throw Error('PNG critical chunk');
  if(type==='IDAT')data.push(b.subarray(pos+8,end-4));
  if(type==='IEND'){ended=true;if(size!==0||end!==b.length)throw Error('PNG end');break;}
  pos=end;
 }
 const channels={0:1,2:3,3:1,4:2,6:4}[b[25]];
 if(!ended||!channels||b[24]!==8||b[26]!==0||b[27]!==0||b[28]!==0)throw Error('Unsupported PNG layout');
 const expected=b.readUInt32BE(20)*(1+b.readUInt32BE(16)*channels);
 const raw=require('node:zlib').inflateSync(Buffer.concat(data),{maxOutputLength:expected});if(raw.length!==expected)throw Error('PNG pixels');
 return Buffer.concat(kept);
}
if(!isMainThread){
 (async()=>{try{const {loadImage,createCanvas}=require('@napi-rs/canvas');const img=await loadImage(cleanPng(Buffer.from(workerData)));const canvas=createCanvas(img.width,img.height);canvas.getContext('2d').drawImage(img,0,0);parentPort.postMessage({buffer:canvas.toBuffer('image/png')});}catch{parentPort.postMessage({error:true});}})();
}else module.exports=async(name,buffer)=>{
 if(buffer.length<33||buffer.length>8*1024**2||buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||buffer.toString('ascii',12,16)!=='IHDR')throw fail('COMPUTE_INVALID_RESULT');
 const w=buffer.readUInt32BE(16),h=buffer.readUInt32BE(20);if(!w||!h||w>4096||h>4096||w*h>8e6)throw fail('COMPUTE_OUTPUT_LIMIT');
 return new Promise((resolve,reject)=>{
  const worker=new Worker(__filename,{workerData:buffer,resourceLimits:{maxOldGenerationSizeMb:96}});let done=false;
  const finish=(err,b)=>{if(done)return;done=true;clearTimeout(timer);worker.terminate().then(()=>err?reject(err):resolve({name,mimetype:'image/png',buffer:Buffer.from(b)}),reject);};
  const timer=setTimeout(()=>finish(fail('COMPUTE_TIMEOUT')),10000);
  worker.on('message',r=>finish(r.error?fail('COMPUTE_INVALID_RESULT'):null,r.buffer));worker.on('error',()=>finish(fail('COMPUTE_INVALID_RESULT')));worker.on('exit',()=>{if(!done)finish(fail('COMPUTE_INVALID_RESULT'));});
 });
};
