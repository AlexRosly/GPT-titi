// A persisted adapter version is immutable for the lifetime of a job. Future
// formats get their own adapter/version and validation, not a higher chat limit.
const {fail}=require('../files/validation');
function get(name){
 if(name!=='xlsx-v1')throw fail('DOCUMENT_ADAPTER_UNSUPPORTED');
 return {limits:require('../xlsx/policy').limits,
  hash:require('../xlsx/engine').hash,
  run:(...args)=>require('../xlsx/process').run(...args)};
}
module.exports={get};
