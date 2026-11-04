const {Schema,model}=require('mongoose');
const schema=new Schema({_id:String,token:String,until:Date},{versionKey:false});
schema.index({until:1},{expireAfterSeconds:86400});
module.exports=model('OcrLease',schema);
