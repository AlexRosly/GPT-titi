const test=require('node:test'),assert=require('node:assert/strict');
process.env.PRIVATE_FILES_ENABLED='true';
const files=require('../../src/services/computation/files');
const action={exports:[{path:'a',filename:'result.csv'}]};
test('host validates export names, sizes, UTF-8 and output opt-out; neutralizes CSV formulas',async()=>{
 const r={ok:true,exports:[{filename:'result.csv',data:Buffer.from('Name,Value\nA,=1+1').toString('base64')}]};
 const [out]=await files.outputs(r,action,{});assert.match(out.buffer.toString(),/'=1\+1/);
 await assert.rejects(files.outputs(r,action,{fileOutputEnabled:false}));
 await assert.rejects(files.outputs({...r,exports:[{...r.exports[0],filename:'wrong.csv'}]},action,{}));
 await assert.rejects(files.outputs({...r,exports:[{filename:'result.csv',data:'!!!!'}]},action,{}));
});
test('calculation exports real XLSX through existing safe renderer and validates PNG pixels',async()=>{
 const [out]=await files.outputs({ok:true,exports:[{filename:'table.xlsx',data:Buffer.from(JSON.stringify({sheets:[{name:'Data',rows:[['Name','Value'],['A',42]]}]})).toString('base64')}]},{exports:[{path:'a',filename:'table.xlsx'}]},{});
 assert.equal(out.buffer.readUInt32LE(0),0x04034b50);assert.equal(out.generatedPreview.kind,'workbook');
 const canvas=require('@napi-rs/canvas').createCanvas(20,20);const png=canvas.toBuffer('image/png');
 const [image]=await files.outputs({ok:true,exports:[{filename:'plot.png',data:png.toString('base64')}]},{exports:[{path:'a',filename:'plot.png'}]},{});assert.equal(image.mimetype,'image/png');
 const bomb=Buffer.from(png);bomb.writeUInt32BE(100000,16);await assert.rejects(require('../../src/services/computation/png')('a.png',bomb));
});
test('a guessed or other-chat file ID is rejected before any storage read',async()=>{
 await assert.rejects(files.inputs({user:'owner',computeState:{files:[]}},{fileIds:['012345678901234567890123']},[]),e=>e.fileError==='COMPUTE_FILE_FORBIDDEN');
});
