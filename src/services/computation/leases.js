const mongoose=require('mongoose');const crypto=require('node:crypto');
const Lease=require('../../models/computationLease');const {limits,fail}=require('./policy');
async function acquire(user){
 const l=limits(),host=process.env.COMPUTE_HOST_ID||require('node:os').hostname(),token=crypto.randomUUID();
 for(let slot=0;slot<l.slots;slot++){
  const ids=['user:'+user,'host:'+host+':'+slot],s=await mongoose.startSession();
  try{
   await s.withTransaction(async()=>{
    for(const id of ids){
     await Lease.deleteOne({_id:id,expiresAt:{$lte:new Date()}},{session:s});
     await Lease.create([{_id:id,token,expiresAt:new Date(Date.now()+l.durationMs+75000)}],{session:s});
    }
   });
   return async()=>{await Lease.deleteMany({_id:{$in:ids},token});};
  }catch(e){if(e.code!==11000)throw e;}finally{await s.endSession();}
 }
 throw fail('COMPUTE_BUSY');
}
module.exports={acquire};
