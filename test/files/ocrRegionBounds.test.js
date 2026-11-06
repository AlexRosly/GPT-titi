const test=require('node:test'),assert=require('node:assert/strict');
const bounds=require('../../src/services/files/ocrRegionBounds');
function raster(width=600,height=300){const data=new Uint8ClampedArray(width*height*4).fill(255);return {data,width,height};}
function ink(im,left,top,right,bottom){for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){const p=(y*im.width+x)*4;im.data[p]=im.data[p+1]=im.data[p+2]=0;}}
function letters(im,left,right,top,bottom){for(let x=left;x<right-8;x+=12)ink(im,x,top,x+8,bottom);}
const line=(text,left,top,right,bottom)=>({words:[text],left,top,right,bottom,confidence:70});
test('pixel regions recover cropped edges and combine same-row fragments without crossing columns or adjacent rows',()=>{
 const im=raster();letters(im,10,260,30,50);letters(im,400,590,30,50);letters(im,10,260,90,110);
 const found=bounds.detect(im,600,300);assert.equal(found.regions.length,3);
 const source=[line('English:',10,30,66,50),line('complete sentence',82,28,250,55),line('right column text',400,30,582,50),line('next row text',90,86,210,114)];
 const saved=JSON.stringify(source);const result=bounds.match(source,found.regions);
 assert.equal(result.candidates.length,3);assert.equal(result.unmatched,0);assert.equal(JSON.stringify(source),saved);
 const joined=result.candidates.find(v=>v.line===1);assert.deepEqual(joined.sourceLines,[1,2]);assert.equal(joined.text,'English:\ncomplete sentence');assert.ok(joined.right<400);
 const lower=result.candidates.find(v=>v.line===4);assert.ok(lower.left<90);assert.ok(lower.right>210);assert.equal(lower.top,90);
});
test('ambiguous boxes spanning two columns or two rows are reported unmatched, never forcibly merged',()=>{
 const found=[{left:0,top:0,right:150,bottom:20},{left:300,top:0,right:450,bottom:20},{left:0,top:40,right:150,bottom:60}];
 const result=bounds.match([line('whole two columns',0,0,450,20),line('whole two rows',0,0,150,60)],found);
 assert.equal(result.candidates.length,0);assert.equal(result.unmatched,2);
});
test('RTL words retain their exact primary order and script-independent row mapping',()=>{
 const source=[{...line('ignored',120,30,220,50),words:['العربية','القاهرة']},line('ירושלים טקסט',250,30,380,50)];
 const r=bounds.match(source,[{left:100,top:30,right:400,bottom:50}]);
 assert.equal(r.candidates[0].text,'العربية القاهرة\nירושלים טקסט');assert.deepEqual(r.candidates[0].sourceLines,[1,2]);
});
test('blank, oversized, invalid and large graphic rasters cannot produce unbounded line work',()=>{
 assert.deepEqual(bounds.detect(raster(),600,300),{regions:[],truncated:false});
 assert.throws(()=>bounds.detect({width:2000,height:2000,data:[]},2000,2000),/REGION_RASTER_LIMIT/);
 const im=raster();ink(im,20,10,580,290);assert.equal(bounds.detect(im,600,300).regions.length,0);
});
test('recognition that misses a crop edge is explicitly incomplete, even if its numbers match',()=>{
 const row={left:10,top:20,right:210,bottom:60},place={x:2,scale:1};
 assert.deepEqual(bounds.edgeCoverage(row,{words:[{left:24,width:200}]},place),{left:true,right:true});
 assert.deepEqual(bounds.edgeCoverage(row,{words:[{left:80,width:144}]},place),{left:false,right:true});
 assert.deepEqual(bounds.edgeCoverage(row,{words:[{left:24,width:140}]},place),{left:true,right:false});
 assert.deepEqual(bounds.edgeCoverage(row,{words:[]},place),{left:false,right:false});
});
test('a narrow gutter wider than a character-height fraction still separates columns',()=>{
 const im=raster();letters(im,10,150,30,50);letters(im,172,320,30,50);
 const r=bounds.detect(im,600,300);assert.equal(r.regions.length,2);assert.ok(r.regions[0].right<r.regions[1].left);
});
