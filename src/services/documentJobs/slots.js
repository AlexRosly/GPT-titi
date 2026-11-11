const Lease=require('../../models/documentJobLease'),store=require('../files/store');
const {fail}=require('../files/validation');
const ttl=90000,concurrency=()=>Math.max(1,Math.min(2,Math.floor(Number(process.env.DOCUMENT_JOB_CONCURRENCY)||1)));
async function init(){for(let i=0;i<concurrency();i++)await Lease.updateOne({_id:'slot:'+i},{$setOnInsert:{until:new Date(0)}},{upsert:true});}
async function acquire(user,token){try{return await store.transaction(async session=>{
 const key='user:'+user;await Lease.findOneAndUpdate({_id:key,$or:[{until:{$lte:new Date()}},{token}]},{$set:{token,until:new Date(Date.now()+ttl)}},{upsert:true,new:true,session});
 for(let i=0;i<concurrency();i++){const slot='slot:'+i;const got=await Lease.findOneAndUpdate({_id:slot,until:{$lte:new Date()}},{$set:{token,until:new Date(Date.now()+ttl)}},{new:true,session});if(got)return [key,slot];}
 throw fail('DOCUMENT_JOB_BUSY');
 });}catch(e){if(e.code===11000)throw fail('DOCUMENT_JOB_BUSY');throw e;}}
async function verify(keys,token,session){for(const key of keys){const r=await Lease.updateOne({_id:key,token,until:{$gt:new Date()}},{$set:{until:new Date(Date.now()+ttl)}},{session});if(!r.matchedCount)throw Object.assign(fail('DOCUMENT_LEASE_LOST'),{staleLease:true});}}
const release=(keys,token)=>Lease.updateMany({_id:{$in:keys},token},{$set:{until:new Date(0)}});
module.exports={init,acquire,verify,release,ttl,concurrency};
