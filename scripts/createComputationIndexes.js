require('dotenv').config();
const mongoose=require('mongoose');const Lease=require('../src/models/computationLease');
(async()=>{const uri=process.env.MONGO_URI||process.env.MONGODB_URI;if(!uri)throw Error('MONGO_URI or MONGODB_URI required');await mongoose.connect(uri);await Lease.createCollection();await Lease.createIndexes();console.log('Computation lease collection is ready.');})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>mongoose.disconnect());
