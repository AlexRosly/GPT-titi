// ZIP parsing never writes entry paths to disk. Only classic stored/deflated ZIP.
const { inflateRawSync, deflateRawSync } = require('node:zlib');
const { fail } = require('./validation');
const LIMITS = Object.freeze({ inputBytes:10*1024**2, expandedBytes:25*1024**2, entryBytes:5*1024**2, entries:20, records:100, textBytes:128*1024, outputEntries:10 });
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=bytes=>{let n=0xffffffff;for(const b of bytes)n=table[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;};
function safePath(name,directory=false){
 if(typeof name!=='string' || !name || Buffer.byteLength(name)>240 || /[\x00-\x1f\x7f\\:%\u202a-\u202e\u2066-\u2069]/u.test(name) || name.startsWith('/'))throw fail('ZIP_UNSAFE_PATH');
 const parts=(directory&&name.endsWith('/')?name.slice(0,-1):name).split('/');
 if(parts.length>8 || parts.some(p=>!p || p==='.' || p==='..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw fail('ZIP_UNSAFE_PATH');
 return name;
}
const bad=()=>{throw fail('INVALID_ZIP',422);};
const limit=()=>{throw fail('ZIP_LIMIT',413);};
function extras(buffer,start,length,end){
 if(start+length>end)bad();const finish=start+length;
 while(start<finish){if(start+4>finish)bad();const id=buffer.readUInt16LE(start),size=buffer.readUInt16LE(start+2);
  if(id===1||id===0x9901)throw fail('ZIP_UNSUPPORTED',422);
  start+=4+size;if(start>finish)bad();
 }
}

function read(buffer){
 if(!Buffer.isBuffer(buffer)||buffer.length<22||buffer.length>LIMITS.inputBytes)throw fail('ZIP_TOO_LARGE',413);
 let end=-1;
 for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50 && i+22+buffer.readUInt16LE(i+20)===buffer.length){end=i;break;}
 if(end<0 || buffer.readUInt16LE(end+4) || buffer.readUInt16LE(end+6))bad();
 const count=buffer.readUInt16LE(end+10),size=buffer.readUInt32LE(end+12),start=buffer.readUInt32LE(end+16);
 if(!count || count>LIMITS.records)limit();
 if(buffer.readUInt16LE(end+8)!==count || start+size!==end)bad();
 const rows=[],seen=new Set(),ranges=[];let cursor=start,total=0,files=0;
 for(let i=0;i<count;i++){
  if(cursor+46>end || buffer.readUInt32LE(cursor)!==0x02014b50)bad();
  const flags=buffer.readUInt16LE(cursor+8),method=buffer.readUInt16LE(cursor+10),crc=buffer.readUInt32LE(cursor+16),compressed=buffer.readUInt32LE(cursor+20),length=buffer.readUInt32LE(cursor+24);
  const nl=buffer.readUInt16LE(cursor+28),extra=buffer.readUInt16LE(cursor+30),comment=buffer.readUInt16LE(cursor+32),offset=buffer.readUInt32LE(cursor+42);
  if(flags&(1|64))throw fail('ZIP_ENCRYPTED',422);
  if(![0,8].includes(method)||flags&~(0x800|8|6)||buffer.readUInt16LE(cursor+34))throw fail('ZIP_UNSUPPORTED',422);
  if(cursor+46+nl+extra+comment>end || offset+30>start)bad();
  extras(buffer,cursor+46+nl,extra,end);
  const rawName=buffer.subarray(cursor+46,cursor+46+nl);let name;
  try{name=new TextDecoder('utf-8',{fatal:true}).decode(rawName);}catch{throw fail('ZIP_FILENAME_ENCODING',422);}
  const directory=name.endsWith('/');safePath(name,directory);
  const key=name.replace(/\/$/,'').normalize('NFC').toLowerCase();if(seen.has(key))throw fail('ZIP_UNSAFE_PATH');seen.add(key);
  const mode=(buffer.readUInt32LE(cursor+38)>>>16)&0xf000;
  if(mode && mode!==(directory?0x4000:0x8000))throw fail('ZIP_UNSUPPORTED',422);
  if(!directory && ++files>LIMITS.entries)limit();
  total+=length;if(total>LIMITS.expandedBytes || length>LIMITS.entryBytes || (directory&&length))limit();
  if(buffer.readUInt32LE(offset)!==0x04034b50 || buffer.readUInt16LE(offset+6)!==flags || buffer.readUInt16LE(offset+8)!==method)bad();
  const localName=buffer.readUInt16LE(offset+26),localExtra=buffer.readUInt16LE(offset+28),data=offset+30+localName+localExtra;
  extras(buffer,offset+30+localName,localExtra,start);
  if(data+compressed>start || !buffer.subarray(offset+30,offset+30+localName).equals(rawName))bad();
  if(!(flags&8) && (buffer.readUInt32LE(offset+14)!==crc || buffer.readUInt32LE(offset+18)!==compressed || buffer.readUInt32LE(offset+22)!==length))bad();
  let recordEnd=data+compressed;
  if(flags&8){
   const signed=recordEnd+4<=start && buffer.readUInt32LE(recordEnd)===0x08074b50;const d=recordEnd+(signed?4:0);
   if(d+12>start || buffer.readUInt32LE(d)!==crc || buffer.readUInt32LE(d+4)!==compressed || buffer.readUInt32LE(d+8)!==length)bad();recordEnd=d+12;
  }
  rows.push({name,directory,data,compressed,length,method,crc,key});ranges.push([offset,recordEnd]);cursor+=46+nl+extra+comment;
 }
 if(cursor!==end || !files)bad();ranges.sort((a,b)=>a[0]-b[0]);
 if(ranges[0][0]!==0 || ranges.some((r,i)=>i&&r[0]<ranges[i-1][1]))bad();
 for(const r of rows)if(!r.directory && rows.some(s=>s.key.startsWith(r.key+'/')))throw fail('ZIP_UNSAFE_PATH');
 return rows.map(r=>{
  let bytes;try{const raw=buffer.subarray(r.data,r.data+r.compressed);bytes=r.method===8?inflateRawSync(raw,{maxOutputLength:Math.max(1,r.length)}):raw;}catch{bad();}
  if(bytes.length!==r.length || crc32(bytes)!==r.crc)bad();return r.directory ? null : {path:r.name,buffer:bytes};
 }).filter(Boolean);
}
function write(entries){
 if(!Array.isArray(entries)||!entries.length||entries.length>LIMITS.outputEntries)limit();
 let offset=0,total=0;const chunks=[],central=[],seen=new Set();
 for(const e of entries){
  safePath(e.path);const key=e.path.normalize('NFC').toLowerCase();if(seen.has(key)||[...seen].some(n=>n.startsWith(key+'/')||key.startsWith(n+'/')))throw fail('ZIP_UNSAFE_PATH');seen.add(key);
  if(!Buffer.isBuffer(e.buffer))bad();total+=e.buffer.length;if(total>LIMITS.expandedBytes||e.buffer.length>8*1024**2)limit();
  const name=Buffer.from(e.path),bytes=deflateRawSync(e.buffer),crc=crc32(e.buffer);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);
  local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(e.buffer.length,22);local.writeUInt16LE(name.length,26);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);local.copy(c,6,4,30);c.writeUInt32LE(offset,42);
  chunks.push(local,name,bytes);central.push(c,name);offset+=local.length+name.length+bytes.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...chunks,directory,end]);
}
module.exports={LIMITS,safePath,read,write,crc32};
