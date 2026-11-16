// Configuration helpers for the explicitly local, systemd-managed VPS database.
function localUri(value) {
  let uri;
  try { uri = new URL(value); } catch { throw Error('MONGO_URI is not a valid local MongoDB URI.'); }
  if (uri.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(uri.hostname) ||
      uri.port !== '27017' || !uri.username || !uri.password || !uri.pathname.slice(1) ||
      ['admin', 'config', 'local'].includes(decodeURIComponent(uri.pathname.slice(1)))) {
    throw Error('This repair supports only an authenticated application database at localhost:27017.');
  }
  return uri;
}

function configurations(config, setName, keyFile) {
  if (!config || typeof config !== 'object' || !config.storage?.dbPath || config.sharding ||
      config.net?.port && config.net.port !== 27017 || config.security?.enableEncryption ||
      config.net?.tls?.mode && config.net.tls.mode !== 'disabled') {
    throw Error('Unsupported mongod configuration; manual review required.');
  }
  const maintenance = structuredClone(config), secure = structuredClone(config);
  maintenance.net = { ...maintenance.net, bindIp: '127.0.0.1', port: 27017 };
  delete maintenance.net.bindIpAll;
  maintenance.replication = { ...maintenance.replication, replSetName: setName };
  maintenance.security = { ...maintenance.security, authorization: 'disabled' };
  for (const key of ['keyFile', 'clusterAuthMode', 'transitionToAuth']) delete maintenance.security[key];
  secure.net = { ...secure.net, bindIp: '127.0.0.1', port: 27017 };
  delete secure.net.bindIpAll;
  secure.replication = { ...secure.replication, replSetName: setName };
  secure.security = { ...secure.security, authorization: 'enabled', keyFile, clusterAuthMode: 'keyFile' };
  delete secure.security.transitionToAuth;
  return { maintenance, secure };
}

function replicaUri(value, setName) {
  const uri = localUri(value);
  uri.searchParams.set('replicaSet', setName);
  uri.searchParams.set('directConnection', 'true');
  return uri.toString();
}

function updateEnv(text, uri) {
  for (const key of ['MONGO_URI', 'CHAT_RECONCILIATION_MONGO_URI']) {
    const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`, 'gm');
    const line = `${key}=${uri}`;
    if (re.test(text)) text = text.replace(re, () => line);
    else text += `${text.endsWith('\n') ? '' : '\n'}${line}\n`;
  }
  return text;
}

module.exports = { localUri, configurations, replicaUri, updateEnv };
