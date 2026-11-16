// Run on the Ubuntu VPS as root, from the backend checkout. Never run on Atlas.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const YAML = require('yamljs');
const { MongoClient } = require('mongodb');
const { localUri, configurations, replicaUri, updateEnv } = require('../src/services/localMongoReplicaSet');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const safe = message => Object.assign(Error(message), { safe: true });
const secrets = [];
function redacted(value) {
  let text = String(value || '').replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/g, '[MONGO_URI_REDACTED]');
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text.slice(0, 4000);
}
const command = (name, args, label, options = {}) => {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 300000, ...options });
  if (result.error || result.status !== 0) throw safe(`${label} failed: ${redacted(result.error?.message || result.stderr || 'exit ' + result.status)}`);
  return (result.stdout || '').trim();
};
async function connected(uri, fn) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, appName: 'gptiti-local-mongo-repair' });
  try { await client.connect(); return await fn(client); } finally { await client.close(); }
}
async function waitFor(uri, primary) {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const hello = await connected(uri, client => client.db().command({ hello: 1 }));
      if (!primary || hello.isWritablePrimary) return hello;
    } catch { /* The service/election may still be starting. */ }
    await pause(1000);
  }
  throw safe('MongoDB did not become ready. Inspect journalctl -u mongod -n 80 --no-pager.');
}
async function verifyTransactions(uri) {
  return connected(uri, async client => {
    const hello = await client.db().command({ hello: 1 });
    if (!hello.setName || !hello.isWritablePrimary) throw safe('MongoDB is not a writable replica-set primary.');
    const session = client.startSession();
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' } });
      await client.db().collection('users').findOne({}, { session, projection: { _id: 1 } });
      await session.abortTransaction();
    } finally { await session.endSession(); }
    return { replicaSet: hello.setName, isWritablePrimary: true, transactionReadPassed: true };
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply' && !/^--pm2-id=\d+$/.test(arg))) throw safe('Usage: node scripts/enableLocalMongoReplicaSet.js [--apply] [--pm2-id=1]');
  if (process.platform !== 'linux' || process.getuid() !== 0) throw safe('Run this script as root on the Ubuntu VPS, from the backend root.');
  process.umask(0o077);
  const pm2Id = args.find(arg => arg.startsWith('--pm2-id='))?.split('=')[1] || '1';
  const envPath = path.resolve('.env'), confPath = '/etc/mongod.conf';
  const originalEnv = fs.readFileSync(envPath, 'utf8');
  const env = require('dotenv').parse(originalEnv);
  const uri = env.MONGO_URI;
  const parsed = localUri(uri);
  secrets.push(uri, parsed.password, decodeURIComponent(parsed.password));
  const originalConfig = fs.readFileSync(confPath, 'utf8');
  const config = YAML.parse(originalConfig);
  const setName = config.replication?.replSetName || 'rs0';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(setName)) throw safe('Unsupported replica-set name.');
  const keyFile = config.security?.keyFile || '/etc/mongod-gptiti.keyfile';
  const { maintenance, secure } = configurations(config, setName, keyFile);
  command('systemctl', ['is-active', '--quiet', 'mongod'], 'mongod readiness');
  const hello = await connected(uri, client => client.db().command({ hello: 1 }));
  if (hello.setName && hello.setName !== setName) throw safe('Running replica set differs from mongod.conf. Review before changing anything.');
  console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'check',
    database: decodeURIComponent(parsed.pathname.slice(1)), host: parsed.hostname,
    currentReplicaSet: hello.setName || null, targetReplicaSet: setName, pm2Id }));
  if (!args.includes('--apply')) {
    console.log('Read-only check completed. --apply backs up the DB, stops backend, enables a local replica set and restores authorization.');
    return;
  }
  command('pm2', ['describe', pm2Id], 'PM2 process lookup');
  if (!hello.setName && !command('mongodump', ['--help'], 'mongodump availability').includes('--config')) throw safe('Install MongoDB Database Tools with mongodump --config support first.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = '/root/mongo-migration';
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const confBackup = path.join(directory, `mongod-before-rs-${stamp}.conf`);
  const envBackup = path.join(directory, `backend-before-rs-${stamp}.env`);
  fs.writeFileSync(confBackup, originalConfig, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(envBackup, originalEnv, { mode: 0o600, flag: 'wx' });
  const maintenancePath = '/run/gptiti-mongo-maintenance.conf';
  const overridePath = '/run/systemd/system/mongod.service.d/gptiti-repair.conf';
  if (fs.existsSync(maintenancePath) || fs.existsSync(overridePath)) throw safe('Previous repair runtime files exist. Inspect them before restarting this repair.');
  let configChanged = false, envChanged = false, maintenanceActive = false, completed = false;
  const removeMaintenance = () => {
    for (const filename of [overridePath, maintenancePath]) if (fs.existsSync(filename)) fs.unlinkSync(filename);
    command('systemctl', ['daemon-reload'], 'Reload original service configuration');
    maintenanceActive = false;
  };
  const restore = () => {
    const mustRestart = configChanged || maintenanceActive;
    if (envChanged) fs.writeFileSync(envPath, originalEnv);
    if (configChanged) fs.writeFileSync(confPath, originalConfig);
    if (maintenanceActive) removeMaintenance();
    if (mustRestart) command('systemctl', ['restart', 'mongod'], 'Restore original secured MongoDB');
  };
  const interrupted = () => {
    if (completed) process.exit(0);
    try {
      // Runtime service overrides vanish on reboot as well. The permanent config
      // is never replaced by a configuration with authorization disabled.
      restore();
    } catch { console.error('Restore config from ' + confBackup + ' and inspect journalctl before starting backend.'); }
    console.error('Repair interrupted. Backend remains stopped.');
    process.exit(130);
  };
  command('pm2', ['stop', pm2Id], 'Backend stop');
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    if (!hello.setName) {
      const dumpConfig = path.join(directory, `dump-${stamp}.yml`);
      const archive = path.join(directory, `before-rs-${stamp}.archive.gz`);
      fs.writeFileSync(dumpConfig, YAML.stringify({ uri }, 4), { mode: 0o600, flag: 'wx' });
      try { command('mongodump', ['--config', dumpConfig, '--archive=' + archive, '--gzip'], 'Application database backup'); }
      finally { fs.unlinkSync(dumpConfig); }
      console.log('Database backup: ' + archive);
      const serviceUser = command('systemctl', ['show', 'mongod', '--property=User', '--value'], 'mongod service user') || 'root';
      const uid = Number(command('id', ['-u', serviceUser], 'mongod user ID'));
      const gid = Number(command('id', ['-g', serviceUser], 'mongod group ID'));
      if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(756).toString('base64'), { mode: 0o400, flag: 'wx' });
      fs.chownSync(keyFile, uid, gid); fs.chmodSync(keyFile, 0o400);
      // Keep the permanent config secured. A /run-only service override uses the
      // loopback maintenance config, and disappears if the VPS reboots.
      maintenanceActive = true;
      fs.writeFileSync(maintenancePath, YAML.stringify(maintenance, 12, 2), { mode: 0o644, flag: 'wx' });
      fs.chownSync(maintenancePath, uid, gid); fs.chmodSync(maintenancePath, 0o400);
      fs.mkdirSync(path.dirname(overridePath), { recursive: true });
      fs.writeFileSync(overridePath, '[Service]\nExecStart=\nExecStart=/usr/bin/mongod --config=' + maintenancePath + '\n', { mode: 0o644, flag: 'wx' });
      command('systemctl', ['daemon-reload'], 'Load maintenance service configuration');
      command('systemctl', ['restart', 'mongod'], 'Maintenance MongoDB restart');
      const maintenanceUri = 'mongodb://127.0.0.1:27017/admin?directConnection=true';
      await waitFor(maintenanceUri, false);
      await connected(maintenanceUri, async client => {
        try { await client.db('admin').command({ replSetInitiate: { _id: setName, members: [{ _id: 0, host: 'localhost:27017' }] } }); }
        catch (error) { if (error.codeName !== 'AlreadyInitialized' && error.code !== 23) throw error; }
      });
      await waitFor(maintenanceUri, true);
      const credentials = { user: 'gptiti_ops_' + Date.now(), password: crypto.randomBytes(32).toString('hex'), authSource: 'admin' };
      secrets.push(credentials.password);
      const credentialsPath = path.join(directory, `mongo-admin-${stamp}.json`);
      fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), { mode: 0o600, flag: 'wx' });
      await connected(maintenanceUri, client => client.db('admin').command({ createUser: credentials.user,
        pwd: credentials.password, roles: [{ role: 'root', db: 'admin' }] }));
      console.log('Administrative credentials (root-only file): ' + credentialsPath);
      configChanged = true;
      fs.writeFileSync(confPath, YAML.stringify(secure, 12, 2));
      removeMaintenance();
      command('systemctl', ['restart', 'mongod'], 'Secured MongoDB restart');
    }
    const newUri = replicaUri(uri, setName);
    await waitFor(newUri, true);
    console.log(JSON.stringify(await verifyTransactions(newUri)));
    envChanged = true;
    fs.writeFileSync(envPath, updateEnv(originalEnv, newUri), { mode: 0o600 });
    command('pm2', ['restart', pm2Id, '--update-env'], 'Backend restart', {
      env: { ...process.env, MONGO_URI: newUri, CHAT_RECONCILIATION_MONGO_URI: newUri } });
    completed = true;
    console.log('Replica set and authorization are enabled. Application DB/user/password preserved. Backend restarted.');
    console.log('Configuration backups: ' + confBackup + ' and ' + envBackup);
  } catch (error) {
    try {
      restore();
      command('pm2', ['stop', pm2Id], 'Keep backend stopped after failed repair');
    } catch { console.error('Restore failed. Backend must remain stopped. Restore config from ' + confBackup + ' and inspect journalctl.'); }
    console.error('Repair stopped. Backend remains stopped for inspection. Config backup: ' + confBackup);
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    if (completed && maintenanceActive) removeMaintenance();
  }
}
main().catch(error => { console.error(error.safe ? error.message : `Repair failed (${error.name || 'Error'}, code ${error.code || 'unknown'}): ${redacted(error.message)}`); process.exitCode = 1; });
