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
