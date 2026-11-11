// Launched only by the disposable-database test. Parent kills this process
// after a committed checkpoint; no catch/finally cleanup can run.
const uri=process.env.FILES_TEST_MONGO_URI;
if(!uri||! /\/gptiti_files_test_[a-zA-Z0-9_-]+(?:\?|$)/.test(uri)||!process.send)process.exit(2);
const mongoose=require('mongoose'),processXlsx=require('../../../src/services/xlsx/process');
const real=processXlsx.run;
processXlsx.run=(buffer,action,args,options)=>real(buffer,action,args,{...options,onChunk:async c=>{
 await options.onChunk(c);
 if(c.processed===1000){process.send('checkpoint-committed');await new Promise(()=>{});}
}});
(async()=>{await mongoose.connect(uri);await require('../../../src/services/documentJobs/queue').runOnce();process.send('unexpected-finish');await mongoose.disconnect();})().catch(()=>process.exit(3));
