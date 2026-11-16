const test = require('node:test');
const assert = require('node:assert/strict');
const { validateChatSend } = require('../../src/services/chatDeliveryV2/protocol');
const service = '../../src/services/chatDeliveryV2/';

function fixture(t, accept) {
  const replacements = { [service + 'worker']: { setIo() {}, startWorker: async () => {}, wake() {} },
    [service + 'acceptTurn']: accept, [service + 'retryTurn']: async () => {},
    [service + 'snapshot']: { snapshot: async value => value } };
  const saved = new Map();
  for (const [name, exports] of Object.entries(replacements)) {
    const key = require.resolve(name); saved.set(key, require.cache[key]);
    require.cache[key] = { id: key, filename: key, loaded: true, exports };
  }
  const handlerPath = require.resolve('../../src/controllers/ws/handlers/chatDeliveryV2');
  saved.set(handlerPath, require.cache[handlerPath]); delete require.cache[handlerPath];
  t.after(() => { for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; } });
  const events = {};
  require(handlerPath)({ on(name, callback) { assert.equal(name, 'connection'); callback({ user: { _id: 'owner' },
    on(event, handler) { events[event] = handler; } }); } });
  const payload = { protocolVersion: 2, event: 'chat:send', type: 'request', payload: {
    clientMessageId: '64ec6fba-d586-4b4c-8b5a-7382f293fab0', conversationId: '0123456789abcdef01234567', modelId: 'gpt-5.5', message: 'Hello', files: [] } };
  validateChatSend(payload);
  return { events, payload };
}

test('unexpected DB error logs its code without credentials or message and returns generic V2 error', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...values) => logs.push(values));
  const f = fixture(t, async () => { throw Object.assign(Error('mongodb://private:password@localhost/private'),
    { name: 'MongoServerError', code: 20, codeName: 'IllegalOperation' }); });
  let response;
  await f.events['chat:send'](f.payload, value => { response = value; });
  assert.equal(response.error.code, 'INTERNAL_ERROR');
  assert.equal(logs[0][0], 'CHAT_V2_REQUEST_ERROR');
  assert.equal(logs[0][1].event, 'chat:send');
  assert.equal(logs[0][1].code, 20);
  assert.doesNotMatch(JSON.stringify([response, logs]), /password|private/);
});

test('unexpected extra Socket.IO arguments cannot turn an admission error into an uncaught exception', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(t, async () => { throw Object.assign(Error(), { code: 20 }); });
  await assert.doesNotReject(f.events['chat:send'](f.payload, 'extra-postman-argument'));
});
