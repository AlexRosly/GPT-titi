// Child processes exist only in tests. No delay or failpoint is installed in the server.
const fs=require('node:fs'), path=require('node:path');
const adapters=require('../../src/services/documentJobs/adapters');
async function main(){
  const [mode,requested,dir]=process.argv.slice(2);
  const managed=requested==='managed';
  const stage=managed?(fs.existsSync(path.join(dir,'checkpoint.json'))?'second':'first'):requested;
  function mark(name,data){
    const filename=path.join(dir,name);
    fs.writeFileSync(filename+'.tmp',JSON.stringify({...data,pid:process.pid}));
    fs.renameSync(filename+'.tmp',filename);
  }
  const stopAfterCommit=async cursor=>{
    if(managed)mark('checkpoint.json',{checkpoint:cursor});else process.send({checkpoint:cursor});
    await new Promise(()=>{});
  };
  if(mode==='mongo'){
    const mongoose=require('mongoose'), uri=process.env.FILES_TEST_MONGO_URI;
    if(!/^mongodb(?:\+srv)?:\/\/[^/?#]+\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?[^#]*)?$/.test(uri||''))throw Error('Disposable test DB required');
    await mongoose.connect(uri);
    if(stage==='first'){
      const get=adapters.get;
      adapters.get=name=>{
        const adapter=get(name);
        if(name!=='docx-text-v1')throw Error('Unexpected job type in disposable DB');
        return {...adapter,run:(buffer,action,plan,options)=>adapter.run(buffer,action,plan,action!=='chunks'?options:
          {...options,onChunk:async chunk=>{
            await options.onChunk(chunk);
            if(chunk.processed===1500)await stopAfterCommit(chunk.processed);
          }})};
      };
    }
    try{
      const queue=require('../../src/services/documentJobs/queue');
      const until=Date.now()+125000;
      while(!await queue.runOnce()){
        if(!managed||stage!=='second'||Date.now()>=until)throw Error('No eligible job');
        await require('node:timers/promises').setTimeout(500);
      }
    }finally{await mongoose.disconnect();}
    if(managed)mark('finished.json',{});
    return;
  }
  const adapter=adapters.get('docx-text-v1');
  const source=fs.readFileSync(path.join(dir,'source.docx'));
  const {selection,plan}=JSON.parse(fs.readFileSync(path.join(dir,'plan.json')));
  const records=fs.readdirSync(dir).filter(n=>/^part-\d+\.json$/.test(n))
    .map(n=>JSON.parse(fs.readFileSync(path.join(dir,n)))).sort((a,b)=>a.index-b.index);
  const cursor=records.at(-1)?.processed||0;
  if(stage==='second' && cursor!==1500)throw Error('Wrong recovery cursor '+cursor);
  await adapter.run(source,'chunks',plan,{cursor,selection,onChunk:async chunk=>{
    if(chunk.cursor!==(records.at(-1)?.processed||0))throw Error('Replayed or missing chunk');
    const record={...chunk,index:records.length};
    fs.writeFileSync(path.join(dir,'part-'+record.index+'.json'),JSON.stringify(record),{flag:'wx'});
    records.push(record);
    if(stage==='first'&&chunk.processed===1500)await stopAfterCommit(chunk.processed);
  }});
  const result=await adapter.run(source,'assemble',plan,{selection,records});
  fs.writeFileSync(path.join(dir,'result.docx'),Buffer.from(result.buffer),{flag:'wx'});
  fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify({...result.report,resumedFrom:cursor}));
  if(managed)mark('finished.json',{});
}
main().then(()=>{if(process.connected)process.disconnect();}).catch(e=>{console.error(e.message);process.exit(1);});
