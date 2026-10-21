const test=require('node:test'), assert=require('node:assert/strict');
const {PassThrough}=require('node:stream');
const {EventEmitter}=require('node:events');
const dns=require('node:dns').promises, https=require('node:https'), zlib=require('node:zlib');
const policy=require('../../src/services/web/policy'), html=require('../../src/services/web/html'), fetcher=require('../../src/services/web/fetch');
const page='<html><title>Україна &amp; World</title><main><h1>Heading</h1><p>'+ 'Прочитаний текст 日本語 العربية. '.repeat(8)+'</p><table><tr><td>A</td><td>12</td></tr></table></main><nav>NO NAV</nav><script>NO SCRIPT</script></html>';
test('URL policy rejects internal addresses, alternate IP notation, credentials and non-web schemes',()=>{
 for(const value of ['http://127.1','http://2130706433','http://0x7f000001','http://169.254.169.254','http://10.0.0.1','http://100.64.0.1','http://192.168.1.1','http://[::1]','http://[::ffff:127.0.0.1]','http://[fc00::1]','http://[fe80::1]','http://localhost.','http://service.internal','file:///etc/passwd','https://name:pass@example.com','https://example.com:8080','https://example.com\\@localhost']) assert.throws(()=>policy.normalize(value), value);
 assert.equal(policy.normalize('https://EXAMPLE.com/a#x'),'https://example.com/a');
 assert.equal(policy.publicAddress('8.8.8.8'),true);assert.equal(policy.publicAddress('2606:4700:4700::1111'),true);
 assert.equal(policy.publicAddress('2001:db8::1'),false);
});
test('URLs are explicit user input; defaults and independent opt-out work for old/new models',()=>{
 assert.deepEqual(policy.urlsIn('Read [this](https://example.com/a) and https://example.org/b.'),['https://example.com/a','https://example.org/b']);
 assert.equal(policy.enabled({}),false);process.env.WEB_READING_V2_ENABLED='true';assert.equal(policy.enabled({}),true);assert.equal(policy.enabled({fileOutputEnabled:false}),true);
 assert.equal(policy.plan('read https://example.com',{webInputEnabled:false},[],{}),null);
 assert.throws(()=>policy.plan('https://a.com https://b.com https://c.com https://d.com',{}),{webError:'WEB_TOO_MANY_URLS'});delete process.env.WEB_READING_V2_ENABLED;
});
test('HTML extracts multilingual article content, tables and entities without executable/hidden content',()=>{
 const r=html.extract(Buffer.from(page+'<p hidden>HIDDEN</p>'),'text/html;charset=utf-8');
 assert.equal(r.title,'Україна & World'); assert.match(r.text,/日本語 العربية/);assert.match(r.text,/A \| 12/);assert.doesNotMatch(r.text,/NO NAV|NO SCRIPT|HIDDEN/);
 const large=html.extract(Buffer.from('<main>'+ 'абв '.repeat(10000)+'</main>'),'text/html');assert.equal(large.truncated,true);assert.ok(Buffer.byteLength(large.text)<=policy.PAGE_BYTES);assert.doesNotMatch(large.text,/�/);
 assert.throws(()=>html.extract(Buffer.from('<div id="app"></div><script src="app.js"></script>'),'text/html'),{webError:'WEB_JAVASCRIPT_REQUIRED'});
 assert.throws(()=>html.extract(Buffer.from('<title>Verify you are human</title><p>CAPTCHA</p>'),'text/html'),{webError:'WEB_ACCESS_DENIED'});
});
test('DNS validates all answers and pinned lookup does not perform a second resolution',async t=>{
 t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]);
 await assert.rejects(fetcher.addressFor(new URL('https://example.com'),new AbortController().signal),{webError:'WEB_BLOCKED_ADDRESS'});
 let lookups=0;
 t.mock.method(dns,'lookup',async()=>{lookups++;return [{address:'8.8.8.8',family:4}];});
 t.mock.method(https,'request',(url,options,callback)=>{
  assert.equal(options.agent,false);assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Authorization,undefined);
  options.lookup('example.com',{},(error,address,family)=>{assert.equal(address,'8.8.8.8');assert.equal(family,4);});
  const req=new EventEmitter();req.end=()=>{const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'text/html'};callback(res);res.end(page);};return req;
 });
 const result=await fetcher.read('https://example.com');assert.equal(result.url,'https://example.com/');assert.equal(lookups,1);
});
test('redirects revalidate destinations before any private-network request',async t=>{
 t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}]);let requests=0;
 t.mock.method(https,'request',(_url,_options,callback)=>{requests++;const req=new EventEmitter();req.end=()=>{const res=new PassThrough();res.statusCode=302;res.headers={location:'http://169.254.169.254/latest/meta-data'};callback(res);};return req;});
 await assert.rejects(fetcher.read('https://example.com'),{webError:'WEB_BLOCKED_ADDRESS'});assert.equal(requests,1);
});
test('reader bounds decompressed bytes and refuses documents and access walls',async t=>{
 t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}]);
 let response={status:200,type:'text/html',encoding:'gzip',body:zlib.gzipSync(Buffer.alloc(fetcher.MAX_BYTES+1,65))};
 t.mock.method(https,'request',(_url,_options,callback)=>{const req=new EventEmitter();req.end=()=>{const res=new PassThrough();res.statusCode=response.status;res.headers={'content-type':response.type,'content-encoding':response.encoding};callback(res);res.end(response.body);};return req;});
 await assert.rejects(fetcher.read('https://example.com'),{webError:'WEB_PAGE_TOO_LARGE'});
 response={status:200,type:'application/pdf',encoding:'identity',body:Buffer.from('%PDF')};await assert.rejects(fetcher.read('https://example.com'),{webError:'WEB_UNSUPPORTED_TYPE'});
 response.status=403;await assert.rejects(fetcher.read('https://example.com'),{webError:'WEB_ACCESS_DENIED'});
});
test('DNS cancellation and redirect loops are bounded without following private targets',async t=>{
 t.mock.method(dns,'lookup',async()=>new Promise(()=>{}));
 const controller=new AbortController();const pending=fetcher.addressFor(new URL('https://example.com'),controller.signal);controller.abort(policy.fail('WEB_TIMEOUT'));
 await assert.rejects(pending,{webError:'WEB_TIMEOUT'});
 t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}]);let requests=0;
 t.mock.method(https,'request',(_url,_options,callback)=>{requests++;const req=new EventEmitter();req.end=()=>{const res=new PassThrough();res.statusCode=302;res.headers={location:'/again'};callback(res);};return req;});
 await assert.rejects(fetcher.read('https://example.com'),{webError:'WEB_REDIRECT_LIMIT'});assert.equal(requests,4);
});
test('legacy charset is decoded and compressed/uncompressed input limits are enforced',async t=>{
 const iconv=require('iconv-lite');const r=html.extract(iconv.encode('<p>Український текст документа</p>','windows-1251'),'text/html; charset=windows-1251');assert.match(r.text,/Український/);
 t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}]);
 t.mock.method(https,'request',(_url,_options,callback)=>{const req=new EventEmitter();req.end=()=>{const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'text/html','content-length':String(fetcher.MAX_BYTES+1)};callback(res);};return req;});
 await assert.rejects(fetcher.read('https://example.com'),{webError:'WEB_PAGE_TOO_LARGE'});
 assert.throws(()=>policy.normalize('http://168.63.129.16'),{webError:'WEB_BLOCKED_ADDRESS'});
});
