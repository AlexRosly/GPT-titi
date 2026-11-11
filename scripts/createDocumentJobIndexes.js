require('dotenv').config();
const mongoose=require('mongoose');
(async()=>{
 const uri=process.env.MONGO_URI||process.env.MONGODB_URI;if(!uri)throw Error('MONGO_URI or MONGODB_URI required');await mongoose.connect(uri);
 for(const model of [require('../src/models/documentJob'),require('../src/models/documentJobChunk'),require('../src/models/documentJobLease')]){await model.createCollection();await model.createIndexes();}
 await require('../src/services/documentJobs/slots').init();console.log('Document job indexes and worker slots are ready.');
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>mongoose.disconnect());
