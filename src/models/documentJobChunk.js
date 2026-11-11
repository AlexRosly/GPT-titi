const {Schema,model}=require('mongoose');
const schema=new Schema({job:{type:Schema.Types.ObjectId,required:true},index:{type:Number,required:true},cursor:Number,processed:Number,total:Number,start:Number,end:Number,
 xml:{type:String,required:true},hash:{type:String,required:true},matched:Number,changed:Number,formulaSkipped:Number,nonNumericSkipped:Number,bytes:Number},
 {versionKey:false});
schema.index({job:1,index:1},{unique:true});
module.exports=model('DocumentJobChunk',schema);
