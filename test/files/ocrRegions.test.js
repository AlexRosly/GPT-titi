const test = require('node:test');
const assert = require('node:assert/strict');
const regions = require('../../src/services/files/ocrRegions');
const language = require('../../src/services/files/ocrLanguages');
const quality = require('../../src/services/files/ocrQuality');
const available = new Set(['osd', ...language.SCRIPTS.map(s=>'script/'+s)]);
const line = (text, confidence=90) => ({words:[text],confidence,left:10,top:20,right:500,bottom:60});
test('regions use all installed script families with confidence gates and explicit opt-in',()=>{
 const old=process.env.OCR_REGIONS_ENABLED;
 try { delete process.env.OCR_REGIONS_ENABLED; assert.equal(regions.enabled(),false);
 process.env.OCR_REGIONS_ENABLED='true';assert.equal(regions.profile(),'regions-3');
 for(const script of language.SCRIPTS.filter(s=>s!=='Latin'))assert.ok(regions.selection({script,confidence:10},available,['script/Latin']));
 assert.equal(regions.selection({script:'Latin',confidence:10},available,['script/Latin']),null);
 for(const confidence of [null,0,NaN])assert.equal(regions.selection({script:'Arabic',confidence},available,[]),null);
 assert.equal(regions.selection({script:'Korean',confidence:0.9},available,['script/Latin']).detectionUncertain,true);
 assert.equal(regions.selection({script:'Unknown',confidence:10},available,[]),null);
 } finally { if(old===undefined)delete process.env.OCR_REGIONS_ENABLED;else process.env.OCR_REGIONS_ENABLED=old; }
});
test('regional candidates retain original line IDs and never reorder primary text or RTL words',()=>{
 const raw='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n'+
 '5\t1\t1\t1\t1\t1\t400\t20\t90\t30\t95\tالعربية\n'+
 '5\t1\t1\t1\t1\t2\t100\t20\t90\t30\t95\tالقاهرة\n'+
 '5\t1\t2\t1\t1\t1\t20\t80\t300\t30\t20\tUncertain characters\n';
 const parsed=quality.parseTsv(raw), before=JSON.stringify(parsed);
 const selected=regions.candidates(parsed.lines);
 assert.deepEqual(selected.map(l=>l.line),[2,1]);assert.equal(selected[1].text,'العربية القاهرة');
 assert.equal(JSON.stringify(parsed),before);
 assert.equal(regions.candidates([line('ABC-01')]).length,0);
});
test('alternatives preserve exact strings and expose numeric disagreement without repairing dates or amounts',()=>{
 const source={...line('Wrong script 02.11.2026 137,50'),line:4,text:'Wrong script 02.11.2026 137,50'};
 const chosen={script:'Greek',models:['script/Greek']};
 const v=regions.alternative(source,{text:'Ελληνικά 02.11.2026 137,50',confidence:90},chosen);
 assert.equal(v.original,source.text);assert.equal(v.numericAgreement,true);
 const mismatch=regions.alternative(source,{text:'Ελληνικά 02.11.2026 137,60',confidence:90},chosen);
 assert.equal(mismatch.numericAgreement,false);assert.match(mismatch.alternative,/137,60/);
 assert.equal(regions.alternative(source,{text:'guess',confidence:69},chosen),null);
 assert.equal(regions.alternative(source,{text:'first\nsecond',confidence:99},chosen),null);
 const weak={script:'Greek',models:['script/Greek'],detectionUncertain:true};
 assert.equal(regions.alternative({...source,confidence:20},{text:'Latin hallucination',confidence:99},weak),null);
 assert.equal(regions.alternative({...source,confidence:90},{text:'Ελληνικά',confidence:94},weak),null);
 assert.ok(regions.alternative({...source,confidence:20},{text:'Ελληνικά',confidence:90},weak));
 const notes=regions.note([v],true);assert.match(notes,/unverified/);assert.match(notes,/primary text above is unchanged/);assert.match(notes,/CHECK INCOMPLETE/);
 assert.equal(regions.note([],false),'');
});
test('verification time remains within optional and whole-job budgets',()=>{
 assert.equal(regions.budget(0,0),8000);assert.equal(regions.budget(0,8000),0);
 assert.equal(regions.budget(49501,0),0);assert.equal(regions.budget(40000,0,3),0);
 assert.equal(regions.budget(49000,0),1000);
});
test('cache upgrade and checkpoints are keyed by regional profile; old results remain readable',()=>{
 const ocr=require('../../src/services/files/ocrInput'),paged=require('../../src/services/files/ocrPaged');
 const old=process.env.OCR_REGIONS_ENABLED;
 const f={checksum:'abc',ocrCache:{version:3,qualityRevision:3,checksum:'abc',text:'original',languages:require('../../src/services/files/ocrProcess').languages()}};
 const p={revision:1,checksum:'abc',languages:'auto',completed:[{page:1,text:'saved'}]};
 try {delete process.env.OCR_REGIONS_ENABLED;assert.equal(ocr.fresh(f),true);assert.equal(paged.valid(p,f,'auto'),true);
 process.env.OCR_REGIONS_ENABLED='true';assert.equal(ocr.cached(f),true);assert.equal(ocr.fresh(f),false);assert.equal(paged.valid(p,f,'auto'),false);
 p.regionProfile='regions-1';f.ocrCache.regionProfile='regions-1';assert.equal(ocr.fresh(f),false);assert.equal(paged.valid(p,f,'auto'),false);
 p.regionProfile='regions-2';f.ocrCache.regionProfile='regions-2';assert.equal(ocr.cached(f),true);assert.equal(ocr.fresh(f),false);assert.equal(paged.valid(p,f,'auto'),false);
 p.regionProfile='regions-3';f.ocrCache.regionProfile='regions-3';assert.equal(ocr.fresh(f),true);assert.equal(paged.valid(p,f,'auto'),true);
 f.ocrCache.languages='different-model';assert.equal(ocr.fresh(f),false);
 }finally{if(old===undefined)delete process.env.OCR_REGIONS_ENABLED;else process.env.OCR_REGIONS_ENABLED=old;}
});
test('optional notes are dropped before rejecting primary text at the document byte limit',()=>{
 const a='[PDF PAGE 1]\nPrimary 137,50\n',b='[PDF PAGE 2]\nPrimary 731\n';
 const expanded=a.trimEnd()+regions.note([{line:1,original:'X',alternative:'Y'}],false)+'\n';
 const limit=Buffer.byteLength(a+b);
 const fitted=regions.fit([expanded,b],limit);
 assert.equal(fitted.omitted,true);assert.equal(fitted.parts.join(''),a+b);
 assert.deepEqual(regions.fit([a,b],limit),{parts:[a,b],omitted:false});
 assert.equal(regions.fit([a,b+'oversized primary'],limit).omitted,false);
});

test('PSM 13 retries low confidence once, preserves raw strings and the unchanged weak-OSD gate',()=>{
 const source={...line('Wrong primary 731',15.87),line:8,text:'Wrong primary 731'};
 const chosen={script:'Han',models:['HanS','HanT'],detectionUncertain:true};
 const first={text:'这 是 中 文 发 标号 码 731。',confidence:79.56};
 const original=JSON.stringify({source,chosen,first});
 const state={attempts:0},calls=[];
 const recovered=regions.verify(source,first,chosen,{state,remaining:()=>1700,run:(psm,timeout)=>{calls.push([psm,timeout]);return {text:'这 是 中 文 发 票 号 码 731。',confidence:91.8}}});
 assert.deepEqual(calls,[[13,1700]]);assert.equal(state.attempts,1);
 assert.equal(recovered.retry,'accepted');assert.equal(recovered.value.original,source.text);
 assert.equal(recovered.value.psm,13);assert.equal(recovered.value.layoutFallback,true);
 assert.equal(recovered.value.numericAgreement,true);
 assert.equal(JSON.stringify({source,chosen,first}),original);
 const rejected=regions.verify(source,first,chosen,{state,remaining:()=>8000,run:()=>({...first,confidence:84.99})});
 assert.equal(rejected.value,null);assert.equal(rejected.retry,'rejected');
 const limited=regions.verify(source,first,chosen,{state,remaining:()=>8000,run:()=>assert.fail('third retry')});
 assert.equal(limited.retry,'limit');assert.equal(state.attempts,2);
});
test('layout retry is script-independent and cannot bypass script, structure, confidence or budget checks',()=>{
 const source={...line('Primary 137,50',20),line:2,text:'Primary 137,50'};
 const chosen={script:'Greek',models:['Greek','Latin'],detectionUncertain:true};
 const first={text:'Ελληνικά 137,50',confidence:80};
 const noRun=()=>assert.fail('unexpected subprocess');
 for(const result of [{...first,confidence:NaN},{...first,confidence:Infinity},{...first,text:'Latin nonsense'},
   {...first,text:'Ελληνικά\nΕλληνικά'},{...first,text:'Ελληνικά\rΕλληνικά'},
   {...first,text:'Ε'.repeat(2001)},{...first,text:source.text},{...first,text:''}]){
  const out=regions.verify(source,result,chosen,{state:{attempts:0},remaining:()=>8000,run:noRun});assert.equal(out.value,null);assert.equal(out.retry,undefined);
 }
 for(const left of [0,499,NaN]){
  const state={attempts:0};assert.equal(regions.verify(source,first,chosen,{state,remaining:()=>left,run:noRun}).retry,'budget');assert.equal(state.attempts,0);
 }
 const valid=regions.verify(source,{...first,confidence:90},chosen,{state:{attempts:0},remaining:noRun,run:noRun});assert.equal(valid.psm,7);
 for(const result of [{text:'Latin nonsense',confidence:99},{...first,confidence:84.99},{...first,text:'Ελληνικά\nδεύτερη',confidence:99}])assert.equal(regions.verify(source,first,chosen,{state:{attempts:0},remaining:()=>8000,run:()=>result}).value,null);
 const mismatch=regions.verify(source,first,chosen,{state:{attempts:0},remaining:()=>8000,run:(psm,ms)=>{assert.equal(ms,2000);return {text:'Ελληνικά 137,60',confidence:95}}});
 assert.equal(mismatch.value.numericAgreement,false);assert.equal(mismatch.value.alternative,'Ελληνικά 137,60');
 const state={attempts:0};assert.throws(()=>regions.verify(source,first,chosen,{state,remaining:()=>8000,run:()=>{throw Error('timeout')}}),/timeout/);assert.equal(state.attempts,1);
 const strong={...chosen,detectionUncertain:false};assert.ok(regions.verify(source,{...first,confidence:69},strong,{state:{attempts:0},remaining:()=>8000,run:()=>({...first,confidence:70})}).value);
 assert.equal(regions.verify(source,{...first,confidence:69},strong,{state:{attempts:0},remaining:()=>8000,run:()=>({text:'Latin nonsense',confidence:99})}).value,null);
 // A high primary confidence still requires the same five-point gain.
 assert.equal(regions.verify({...source,confidence:90},first,chosen,{state:{attempts:0},remaining:()=>8000,run:()=>({...first,confidence:94})}).value,null);
});
