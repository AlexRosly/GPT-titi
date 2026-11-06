// Horizontal printed-text regions from pixels, independent of recognized glyphs.
// Conservative whitespace cuts keep columns apart. No primary text is rewritten.
function spans(counts, gap) {
  const out=[]; let start=-1,last=-1;
  for(let i=0;i<counts.length;i++) if(counts[i]) {
    if(start<0) start=i;
    else if(i-last>gap+1) {out.push([start,last+1]);start=i;}
    last=i;
  }
  if(start>=0)out.push([start,last+1]);
  return out;
}
function detect({data,width,height}, originalWidth, originalHeight) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>3240000||data.length!==width*height*4)throw new Error('REGION_RASTER_LIMIT');
  const mask=new Uint8Array(width*height),rows=new Uint32Array(height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const at=y*width+x,i=at*4;
    if(data[i+3]>128 && data[i]*0.299+data[i+1]*0.587+data[i+2]*0.114<170){mask[at]=1;rows[y]++;}
  }
  // Ignore isolated single pixels, retain small diacritics and punctuation.
  const bands=spans(rows.map(n=>n>=2?1:0),Math.max(2,Math.round(height/350)));
  const regions=[];const sx=originalWidth/width,sy=originalHeight/height;
  for(const [top,bottom] of bands){
    const h=bottom-top;
    if(h<3||h>height*0.16)continue; // rules/images/vertical text are not line regions
    const cols=new Uint32Array(width);
    for(let y=top;y<bottom;y++)for(let x=0;x<width;x++)cols[x]+=mask[y*width+x];
    for(const [left,right] of spans(cols,Math.max(12,Math.round(h*0.8)))){
      if(right-left<h*1.5)continue;
      regions.push({left:Math.floor(left*sx),top:Math.floor(top*sy),right:Math.ceil(right*sx),bottom:Math.ceil(bottom*sy)});
      if(regions.length>=256)return {regions,truncated:true};
    }
  }
  return {regions,truncated:false};
}
function match(lines, regions) {
  const used=new Set(),out=[];
  const assignments = regions.map(()=>[]);
  lines.forEach((line,index)=>{
    const w=line.right-line.left,h=line.bottom-line.top;
    if(w<=0||h<=0)return;
    const hits=regions.map((box,i)=>{
      const x=Math.max(0,Math.min(line.right,box.right+4)-Math.max(line.left,box.left-4))/w;
      const y=Math.max(0,Math.min(line.bottom,box.bottom+4)-Math.max(line.top,box.top-4))/h;
      return {i,score:x*y,ok:x>=0.85&&y>=0.5};
    }).filter(v=>v.ok).sort((a,b)=>b.score-a.score);
    // Tall/spanning OCR boxes that could belong to two rows are not reassigned.
    if(hits.length && (!hits[1] || hits[1].score<hits[0].score*0.8)) assignments[hits[0].i].push({line,index});
  });
  for(const [i,box] of regions.entries()){
    const members=assignments[i];
    if(!members.length||members.some(m=>used.has(m.index)))continue;
    const text=members.map(m=>m.line.words.join(' ')).join('\n');
    if([...text].filter(c=>/\p{L}/u.test(c)).length<10)continue;
    const weight=members.reduce((n,m)=>n+m.line.words.join(' ').length,0);
    for(const m of members)used.add(m.index);
    out.push({...box,line:members[0].index+1,sourceLines:members.map(m=>m.index+1),text,
      confidence:members.reduce((n,m)=>n+m.line.confidence*m.line.words.join(' ').length,0)/weight,
      boundsStatus:'pixel-region'});
  }
  // No fallback to known-incomplete tight crops: disclose unsupported geometry.
  const unmatched=lines.filter((line,i)=>!used.has(i)&&line.words.join(' ').replace(/[^\p{L}]/gu,'').length>=10).length;
  return {candidates:out.sort((a,b)=>a.confidence-b.confidence||a.line-b.line),unmatched};
}
function edgeCoverage(line, result, placement) {
  const words=result.words || [];
  if(!words.length)return {left:false,right:false};
  const expectedLeft=16+(line.left-placement.x)*placement.scale;
  const expectedRight=16+(line.right-placement.x)*placement.scale;
  const tolerance=Math.max(4,(line.bottom-line.top)*placement.scale*0.35);
  return {left:Math.min(...words.map(w=>w.left))<=expectedLeft+tolerance,
    right:Math.max(...words.map(w=>w.left+w.width))>=expectedRight-tolerance};
}
module.exports={detect,match,edgeCoverage};
