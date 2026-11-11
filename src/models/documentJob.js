const {Schema,model}=require('mongoose');
const schema=new Schema({
 user:{type:Schema.Types.ObjectId,required:true},turn:{type:Schema.Types.ObjectId,required:true},turnId:{type:String,required:true},attempt:{type:Number,required:true},
 adapter:{type:String,required:true,enum:['xlsx-v1']},sourceFile:{type:Schema.Types.ObjectId,required:true},sourceChecksum:{type:String,required:true},
 plan:{type:Schema.Types.Mixed,required:true},selection:{type:Schema.Types.Mixed,required:true},
 status:{type:String,enum:['queued','running','ready','failed','cancelled'],default:'queued'},
 cursor:{type:Number,default:0},total:{type:Number,default:0},chunks:{type:Number,default:0},stagedBytes:{type:Number,default:0},
 matched:{type:Number,default:0},changed:{type:Number,default:0},formulaSkipped:{type:Number,default:0},nonNumericSkipped:{type:Number,default:0},
 failures:{type:Number,default:0},restarts:{type:Number,default:0},leaseToken:String,leaseUntil:Date,notBefore:{type:Date,default:()=>new Date(0)},
 deadline:{type:Date,required:true},finishedAt:Date,errorCode:String,resultFile:Schema.Types.ObjectId,
},{timestamps:true,versionKey:false});
schema.index({turnId:1,attempt:1},{unique:true});
schema.index({status:1,notBefore:1,leaseUntil:1,createdAt:1});
// No TTL on live jobs: cleanup must release staging quota before removing data.
schema.index({finishedAt:1},{expireAfterSeconds:7*86400});
module.exports=model('DocumentJob',schema);
