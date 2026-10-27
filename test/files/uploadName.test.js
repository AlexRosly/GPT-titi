const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const multer = require('multer');
const uploadName = require('../../src/services/files/uploadName');
const { validateUpload } = require('../../src/services/files/validation');

test('multipart upload preserves international filenames before validation', async t => {
  const app = express();
  app.post('/', multer().single('file'), (req,res) => {
    res.json(validateUpload({...req.file, originalname:uploadName(req.file.originalname)}));
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const name of ['Звіт за жовтень.txt','Résumé.txt','日本語.txt','العربية.txt','Звіт 📁.txt','plain.txt']) {
    const body = new FormData(); body.append('file',new Blob(['hello']),name);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`,{method:'POST',body});
    assert.equal(response.status,200); assert.equal((await response.json()).name,name);
  }
});
test('already decoded names and legacy Latin-1 stay intact; validation still rejects unsafe names', () => {
  for (const name of ['Звіт.txt','日本語.txt','Résumé.txt','plain.txt']) assert.equal(uploadName(name),name);
  for (const name of ['../Звіт.txt','Звіт\\x.txt','Звіт\u0001.txt']) {
    const transport = Buffer.from(name).toString('latin1');
    assert.throws(() => validateUpload({originalname:uploadName(transport),buffer:Buffer.from('x')}),{fileError:'INVALID_FILENAME'});
  }
});
