const Lease=require('../../models/ocrLease');
const store=require('./store');
const {fail}=require('./validation');
const ttl=90000;
const concurrency=()=>Math.max(1,Math.min(2,Math.floor(Number(process.env.OCR_BACKGROUND_CONCURRENCY)||2)));
const acquire=async(user,token)=>{
 try { return await store.transaction(async session=>{
   const keys=['user:'+String(user)];
   const userLease=await Lease.findOneAndUpdate({_id:keys[0],$or:[{until:{$lte:new Date()}},{token}]},{$set:{token,until:new Date(Date.now()+ttl)}},{upsert:true,new:true,session});
   if(!userLease)throw fail('OCR_PROCESSING_BUSY',503);
   let slot;
   for(let i=0;i<concurrency();i++){
     // Initialize outside claim operations through insert-once writes handled below.
     const found=await Lease.findOneAndUpdate({_id:'slot:'+i,until:{$lte:new Date()}},{$set:{token,until:new Date(Date.now()+ttl)}},{new:true,session});
     if(found){slot='slot:'+i;break;}
   }
   if(!slot)throw fail('OCR_PROCESSING_BUSY',503);
   return [...keys,slot];
 }); } catch(e){if(e.code===11000)throw fail('OCR_PROCESSING_BUSY',503);throw e;}
};
const init=async()=>{for(let i=0;i<concurrency();i++)await Lease.updateOne({_id:'slot:'+i},{$setOnInsert:{until:new Date(0)}},{upsert:true});};
const verify=async(keys,token,session)=>{
 for(const key of keys){const r=await Lease.updateOne({_id:key,token,until:{$gt:new Date()}},{$set:{until:new Date(Date.now()+ttl)}},session?{session}:{});if(!r.matchedCount)throw fail('PREPARATION_INTERRUPTED',409);}
};
const release=async(keys,token)=>{await Lease.updateMany({_id:{$in:keys},token},{$set:{until:new Date(0)}});};
module.exports={init,acquire,verify,release,concurrency};
