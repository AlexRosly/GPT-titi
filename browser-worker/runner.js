// No secrets, volumes, host network, or user-supplied code in this process.
const readline = require('node:readline');
const { chromium } = require('playwright');
const errors = require('./errors');
let stage = 'launch', mainRequestFailure;
const pending = new Map(); let next = 1, browser, context, page, controls = [];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
function fetchResource(request) {
  const id = next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Resource timeout')); }, 16000);
    pending.set(id, value => { clearTimeout(timer); value.error ? reject(new Error(value.error)) : resolve(value); });
    send({ type: 'fetch', id, url: request.url(), method: request.method(), resourceType: request.resourceType() });
  });
}
async function start() {
  browser = await chromium.launch({ chromiumSandbox: true, headless: true,
    args: ['--disable-background-networking','--disable-quic','--disable-dev-shm-usage'] });
  context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block',
    viewport: { width: 1200, height: 800 }, permissions: [], javaScriptEnabled: true });
  context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000);
  await context.route('**/*', async route => {
    try {
      const result = await fetchResource(route.request());
      await route.fulfill({ status: result.status, headers: result.headers, body: Buffer.from(result.body, 'base64') });
    } catch (error) {
      // Main-document broker failures must survive Chromium's generic ERR_FAILED.
      // Subresource failures remain warnings and never replace this diagnostic.
      try {
        if (route.request().isNavigationRequest() && route.request().frame() === page?.mainFrame()) {
          mainRequestFailure = errors.category(error);
        }
      } catch { /* Some requests have no frame. */ }
      await route.abort().catch(() => {});
    }
  });
  await context.routeWebSocket('**/*', ws => ws.close());
  page = await context.newPage();
  context.on('page', other => { if (other !== page) other.close().catch(() => {}); });
  page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
  page.on('download', download => download.cancel().catch(() => {}));
}
let textOffset = 0;
async function observe(vision, capture, scroll) {
  stage = 'observe';
  const result = await page.evaluate(({ start, capture }) => {
    const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const list = []; let id = 0;
    for (const element of document.querySelectorAll('a[href],details, [role="tab"],form')) {
      if (list.length >= 50 || !visible(element)) continue;
      let kind, url, name;
      if (element.matches('a[href]')) { kind = 'follow'; url = element.href; if (!/^https?:/.test(url) || new URL(url).origin !== location.origin || element.hasAttribute('download')) continue; }
      else if (element.matches('details')) kind = 'expand';
      else if (element.matches('[role="tab"]')) kind = 'tab';
      else {
        const input = element.querySelector('input[type="search"],input[name="q"],input[name="s"],input[name="query"]');
        if (!input?.name || element.method.toLowerCase() !== 'get' || new URL(element.action).origin !== location.origin) continue;
        if (!element.matches('[role="search"]') && !input.matches('[type="search"]')) continue;
        kind = 'search'; url = element.action; name = input.name;
      }
      const ref = 'b' + (++id); element.setAttribute('data-gptiti-ref', ref);
      list.push({ ref, kind, label: (element.getAttribute('aria-label') || element.innerText || name || '').slice(0,120), ...(url ? { url } : {}), ...(name ? { name } : {}) });
    }
    const raw = document.body?.innerText || '';
    const offset = Math.min(start, raw.length);
    const text = raw.slice(offset, offset + 12000);
    const snapshot = capture && raw.length ? raw.slice(0, 2 * 1024 * 1024) : undefined;
    return { url: location.href, title: document.title.slice(0,300), text, offset, snapshot, captureIncomplete: capture && raw.length > snapshot?.length, clipped: offset > 0 || raw.length > offset + text.length, controls: list };
  }, { start: scroll ? textOffset : 0, capture });
  controls = result.controls;
  const bytes = Buffer.from(result.text); result.truncated = result.clipped || bytes.length > 8192; delete result.clipped;
  let end = Math.min(bytes.length, 8192);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  result.text = bytes.toString('utf8', 0, end);
  textOffset = result.offset + result.text.length;
  delete result.offset;
  if (result.snapshot && result.truncated) {
    const full = Buffer.from(result.snapshot);
    let length = Math.min(full.length, 2 * 1024 * 1024);
    while (length < full.length && (full[length] & 0xc0) === 0x80) length--;
    result.snapshot64 = full.subarray(0, length).toString('base64');
    result.captureIncomplete ||= length < full.length;
  }
  delete result.snapshot;
  if (vision) {
    stage = 'screenshot';
    const buffer = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false, timeout: 10000 });
    if (buffer.length <= 400000) result.image = buffer.toString('base64');
  }
  return result;
}
async function perform(action, vision, capture) {
  mainRequestFailure = undefined;
  stage = 'launch';
  if (!browser) await start();
  stage = ['open','follow','search','back'].includes(action.kind) ? 'navigate' : 'interact';
  const c = controls.find(c => c.ref === action.ref && c.kind === action.kind);
  if (action.kind === 'open') await page.goto(action.url, { waitUntil: 'domcontentloaded' });
  else if (action.kind === 'follow' && c) await page.goto(c.url, { waitUntil: 'domcontentloaded' });
  else if (action.kind === 'search' && c) {
    const target = new URL(c.url); target.searchParams.set(c.name, action.query);
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  } else if (action.kind === 'expand' && c) await page.locator(`[data-gptiti-ref="${c.ref}"]`).evaluate(el => { if (el.tagName === 'DETAILS') el.open = true; });
  else if (action.kind === 'tab' && c) await page.locator(`[data-gptiti-ref="${c.ref}"][role="tab"]`).click();
  else if (action.kind === 'scroll') await page.evaluate(() => window.scrollBy(0, 650));
  else if (action.kind === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
  else throw Object.assign(new Error('Action blocked'), {browserReason:'ACTION_BLOCKED'});
  // Bounded wait, never wait for a network-idle condition on a hostile page.
  await page.waitForTimeout(600);
  return observe(vision, capture, action.kind === 'scroll');
}
let chain = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { process.exit(1); }
  if (m.type === 'resource') { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.type === 'action') chain = chain.then(async () => {
    try { send({ type: 'result', id: m.id, result: await perform(m.action, m.vision, m.capture === true) }); }
    catch (error) { const diagnostic = errors.safe({reason:mainRequestFailure || errors.category(error),stage}); send({ type: 'result', id: m.id, error: errors.code(diagnostic.reason), diagnostic }); }
  });
}).on('close', () => { browser?.close().finally(() => process.exit(0)); });
setTimeout(() => process.exit(0), 180000).unref();
