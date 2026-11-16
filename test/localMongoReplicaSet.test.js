const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('../src/services/localMongoReplicaSet');
const uri = 'mongodb://gptiti_app:secret%2Bpassword@127.0.0.1:27017/GP-TITI?authSource=GP-TITI';
const config = { storage: { dbPath: '/var/lib/mongodb', wiredTiger: { engineConfig: { cacheSizeGB: 0.25 } } },
  systemLog: { destination: 'file', path: '/var/log/mongodb/mongod.log' },
  net: { bindIp: '127.0.0.1', port: 27017 }, security: { authorization: 'enabled' } };

test('repair only accepts the explicitly local authenticated application DB', () => {
  assert.equal(helpers.localUri(uri).hostname, '127.0.0.1');
  for (const value of ['mongodb+srv://user:secret@cluster0.example.com/GP-TITI',
    'mongodb://user:secret@65.21.162.90:27017/GP-TITI', 'mongodb://127.0.0.1:27017/GP-TITI',
    'mongodb://user:secret@127.0.0.1:27017/admin', 'invalid']) assert.throws(() => helpers.localUri(value));
});

test('maintenance stays loopback-only and final configuration restores authentication with keyfile', () => {
  const before = structuredClone(config);
  const { maintenance, secure } = helpers.configurations({ ...config, net: { ...config.net, bindIpAll: true },
    security: { ...config.security, keyFile: '/old/key', clusterAuthMode: 'keyFile', transitionToAuth: true } }, 'rs0', '/etc/mongod-gptiti.keyfile');
  assert.equal(maintenance.net.bindIp, '127.0.0.1');
  assert.equal(maintenance.net.bindIpAll, undefined);
  assert.equal(maintenance.security.authorization, 'disabled');
  assert.equal(maintenance.security.keyFile, undefined);
  assert.equal(maintenance.security.transitionToAuth, undefined);
  assert.equal(secure.security.authorization, 'enabled');
  assert.equal(secure.security.keyFile, '/etc/mongod-gptiti.keyfile');
  assert.equal(secure.security.clusterAuthMode, 'keyFile');
  assert.equal(secure.security.transitionToAuth, undefined);
  assert.equal(secure.replication.replSetName, 'rs0');
  assert.deepEqual(secure.storage, config.storage);
  assert.deepEqual(config, before);
});

test('replica URI preserves database, password encoding and authSource', () => {
  const value = new URL(helpers.replicaUri(uri, 'rs0'));
  assert.equal(decodeURIComponent(value.password), 'secret+password');
  assert.equal(value.searchParams.get('authSource'), 'GP-TITI');
  assert.equal(value.searchParams.get('replicaSet'), 'rs0');
  assert.equal(value.searchParams.get('directConnection'), 'true');
});

test('env update replaces active definitions without exposing or interpolating password characters', () => {
  const secretUri = uri.replace('secret%2Bpassword', 'literal$&value');
  const updated = helpers.updateEnv('# keep comment\n MONGO_URI =old\nexport MONGO_URI=duplicate\nOTHER=keep\n', secretUri);
  const parsed = require('dotenv').parse(updated);
  assert.equal(parsed.MONGO_URI, secretUri);
  assert.equal(parsed.CHAT_RECONCILIATION_MONGO_URI, secretUri);
  assert.equal(parsed.OTHER, 'keep');
  assert.match(updated, /# keep comment/);
});

test('unsupported encryption, TLS and sharding configs fail before service changes', () => {
  for (const value of [{ ...config, sharding: { clusterRole: 'shardsvr' } },
    { ...config, security: { enableEncryption: true } }, { ...config, net: { tls: { mode: 'requireTLS' } } }]) {
    assert.throws(() => helpers.configurations(value, 'rs0', '/etc/key'));
  }
});
