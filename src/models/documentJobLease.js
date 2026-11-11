const {Schema,model}=require('mongoose');
const schema=new Schema({_id:String,token:String,until:Date},{versionKey:false});
module.exports=model('DocumentJobLease',schema);
