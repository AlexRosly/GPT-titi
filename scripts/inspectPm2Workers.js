// Print only process metadata, never environment variables, arguments or keys.
function project(list) {
  if (!Array.isArray(list) || list.length > 500) throw Error('Invalid PM2 inventory');
  const text = v => typeof v === 'string' && v.length <= 512 && !/[\x00-\x1f]/.test(v) ? v : null;
  const number = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
  return list.map(p => ({id:number(p.pm_id),pid:number(p.pid),name:text(p.name),
    status:text(p.pm2_env?.status),startedAtMs:number(p.pm2_env?.pm_uptime),
    cwd:text(p.pm2_env?.pm_cwd),script:text(p.pm2_env?.pm_exec_path),mode:text(p.pm2_env?.exec_mode)}));
}
if (require.main === module) {
  try {
    const raw = require('node:child_process').execFileSync('pm2',['jlist'],
      {encoding:'utf8',timeout:10000,maxBuffer:8*1024**2,stdio:['ignore','pipe','pipe']});
    console.log(JSON.stringify({generatedAt:new Date(),processes:project(JSON.parse(raw))},null,2));
  } catch { console.error('Could not read PM2 inventory. Check PM2 locally; do not share raw jlist or environment output.');process.exitCode=1; }
}
module.exports={project};
