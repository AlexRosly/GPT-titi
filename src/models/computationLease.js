const {Schema,model}=require('mongoose');
module.exports=model('computationLease',new Schema({_id:String,token:{type:String,required:true},expiresAt:{type:Date,required:true}},{versionKey:false}));
