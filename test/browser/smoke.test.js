// Real Docker + real Chromium; public network and paid provider calls are mocked.
const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../../src/services/browser/session');
const {broker}=require('../../src/services/browser/network');
const origin='https://example.com';
const home=`<html><body><div id="dynamic"></div><a href="/article">Article</a><details><summary>More</summary>Expanded content</details><form role="search" action="/search" method="get"><input type="search" name="q"></form><script>document.getElementById('dynamic').innerText='JS_RENDERED_OK';fetch('http://127.0.0.1/secret').catch(()=>{});</script></body></html>`;
test('isolated Chromium renders JS, navigates, searches, captures viewport, blocks private network', {timeout:120000},async()=>{
  const seen=[];
  const session=create([origin+'/'],undefined,{broker:(seeds,signal)=>broker(seeds,signal,{
    addressFor:async url=>{assert.equal(url.origin,origin);return {address:'93.184.216.34',family:4};},
    request:async url=>{seen.push(url.href);return {status:200,type:'text/html',body:Buffer.from(url.pathname==='/'?home:`<html><body>Result ${url.pathname} ${url.search}</body></html>`)};}
  })});
  try {
    let obs=await session.action({kind:'open',url:origin+'/'},true);
    assert.match(obs.text,/JS_RENDERED_OK/);assert.ok(obs.image);assert.ok(obs.controls.some(c=>c.kind==='search'));
    obs=await session.action({kind:'expand',ref:obs.controls.find(c=>c.kind==='expand').ref});assert.match(obs.text,/Expanded content/);
    obs=await session.action({kind:'follow',ref:obs.controls.find(c=>c.kind==='follow').ref});assert.equal(obs.url,origin+'/article');
    obs=await session.action({kind:'back'});const search=obs.controls.find(c=>c.kind==='search');
    obs=await session.action({kind:'search',ref:search.ref,query:'Kyiv'});assert.match(obs.url,/q=Kyiv/);
    assert.ok(seen.every(url=>url.startsWith(origin)));
  } finally {session.close();}
});
test('main-document access rejection reaches host as a precise safe diagnostic', {timeout:60000},async()=>{
  const session=create([origin+'/'],undefined,{broker:()=>async message=>{
    if(message.url===origin+'/blocked')throw Object.assign(new Error('private URL must not escape'),{webError:'WEB_ACCESS_DENIED'});
    return {status:200,headers:{'content-type':'text/html'},body:Buffer.from('<html><body>Saved page<a href="/blocked">Next article</a></body></html>').toString('base64')};
  }});
  try {
    const obs=await session.action({kind:'open',url:origin+'/'});
    await assert.rejects(session.action({kind:'follow',ref:obs.controls.find(c=>c.kind==='follow').ref}),error=>{
      assert.equal(error.webError,'BROWSER_NAVIGATION_FAILED');
      assert.equal(error.browserSessionDiagnostic.reason,'HTTP_ACCESS_DENIED');
      assert.equal(error.browserSessionDiagnostic.stage,'navigate');
      assert.equal(error.browserSessionDiagnostic.actionIndex,2);
      assert.ok(!JSON.stringify(error).includes('private URL'));return true;
    });
  } finally {session.close();}
});
