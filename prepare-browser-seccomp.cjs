// Run from the backend repository root. Keeps the previously approved chroot fix.
const fs=require('node:fs');
const path='browser-worker/seccomp.json';
const original=fs.readFileSync(path,'utf8'), profile=JSON.parse(original);
const rules=profile.syscalls.filter(r=>r.names?.length===1 && r.names[0]==='chroot' && r.action==='SCMP_ACT_ALLOW');
if(rules.length!==1)throw new Error('Unexpected seccomp profile: inspect manually; no changes written.');
const rule=rules[0];
if(JSON.stringify(rule.includes||{})==='{}') { console.log('chroot compatibility fix already present.'); process.exit(0); }
if(JSON.stringify(rule.includes)!==JSON.stringify({caps:['CAP_SYS_CHROOT']}))throw new Error('Unexpected chroot condition: no changes written.');
rule.includes={};
fs.writeFileSync(path,JSON.stringify(profile,null,'\t')+'\n');
console.log('Applied existing chroot compatibility fix; other rules preserved.');
