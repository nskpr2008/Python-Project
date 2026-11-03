// Browser end-to-end tests: a real headless Chrome or Edge drives the real page against a throw-away server and database.
// Run with: npm run test:e2e      (set BROWSER_PATH if your browser is not found automatically)
// No dependencies: it speaks the Chrome DevTools Protocol over Node's built-in WebSocket.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../server.mjs';

const CANDIDATES = [process.env.BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'].filter(Boolean);
const browserPath = CANDIDATES.find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voltbay-e2e-'));
const skip = browserPath ? false : 'no Chrome or Edge found (set BROWSER_PATH)';

let app, base, proc, ws, nextId = 1, errors = [];
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
/** Runs an async expression in the page and returns its JSON value. */
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function open(p = '/', { fresh = true } = {}) {
  if (fresh) { // let the first page finish creating its session before clearing storage, so it cannot write a token after the clear
    await send('Page.navigate', { url: base + '/' });
    for (let i = 0; i < 60; i++) { await sleep(150); if (await ev(`return window.VBReady===true && S.products.length>=60 && !!localStorage.getItem('voltbay_token')`).catch(() => false)) break; }
    await ev(`localStorage.clear(); return 1`);
  }
  await send('Page.navigate', { url: base + p });
  for (let i = 0; i < 60; i++) { await sleep(150); if (await ev(`return document.readyState==='complete' && window.VBReady===true && S.products.length>=60 && document.querySelectorAll('#grid .card').length>=60`).catch(() => false)) return; }
  throw new Error('page did not finish loading');
}
const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click(); return 1`);
const wait = async (expr, ms = 6000) => { for (let t = 0; t < ms; t += 150) { if (await ev(`return !!(${expr})`).catch(() => false)) return true; await sleep(150); } { const st = await ev(`return JSON.stringify({ acct: document.getElementById('acctbtn').textContent, mode: document.body.dataset.mode, modal: document.getElementById('modal').classList.contains('open') && document.getElementById('mbox').innerText.slice(0, 120), admin: typeof window.VBAdmin, adminMenu: getComputedStyle(document.querySelector('details.adm')).display })`).catch(() => '?'); throw new Error('timed out waiting for: ' + expr + ' | page state: ' + st); } };

before(async () => {
  if (skip) return;
  const created = createApp({ dbFile: path.join(tmp, 'e2e.db'), ai: { key: '', provider: '' }, adminEmail: 'admin@example.com', adminPassword: '12345' });
  app = created; await new Promise(r => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}`;
  const profile = path.join(tmp, 'profile');
  proc = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) { await sleep(150); try { port = +fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not ready */ } }
  assert.ok(port, 'browser started');
  let target; for (let i = 0; i < 50 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* retry */ } if (!target) await sleep(150); }
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value ?? a.description).join(' '));
    else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon/.test(d.params.entry.url || '') && (!d.params.entry.url || d.params.entry.url.startsWith(base))) errors.push(d.params.entry.text + ' ' + (d.params.entry.url || '')); // only our own site's errors count; a failed Google Fonts download is not ours
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
});
after(async () => {
  try { ws?.close(); } catch { /* ignore */ }
  try { proc?.kill(); } catch { /* ignore */ }
  if (app) await new Promise(r => { app.server.close(() => { app.db.close(); r(); }); app.server.closeAllConnections?.(); });
  await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ }
});

test('storefront loads every product with working photos, no console errors, and no admin menu', { skip }, async () => {
  errors = []; await open();
  const r = await ev(`document.querySelectorAll('img').forEach(i=>i.loading='eager'); await new Promise(r=>setTimeout(r,2500));
    return { products: S.products.length, broken: [...document.querySelectorAll('img')].filter(i=>i.complete&&!i.naturalWidth).map(i=>i.src), admin: getComputedStyle(document.querySelector('details.adm')).display, badge: document.querySelector('.aih span small')?.textContent }`);
  assert.ok(r.products >= 60); assert.deepEqual(r.broken, []); assert.equal(r.admin, 'none'); assert.match(r.badge, /Offline assistant/);
  assert.deepEqual(errors, []);
});

test('the cart survives a reload (server-side session) and checkout records the same order number everywhere', async t => {
  await open();
  await ev(`addCart('VB-115'); addCart('VB-119'); await new Promise(r=>setTimeout(r,1200)); return 1`);
  const before = await ev(`const t=localStorage.getItem('voltbay_token'); const s=await fetch('/api/state',{headers:{authorization:'Bearer '+t}}).then(r=>r.json()); return { token: t && t.slice(0,6), local: Object.keys(S.cart), server: (s.cart||[]).map(i=>i.id), ready: document.body.innerText.length>0 }`);
  await open('/', { fresh: false });
  const after = await ev(`return { token: (localStorage.getItem('voltbay_token')||'').slice(0,6), cart: Object.keys(S.cart).sort() }`);
  assert.deepEqual(after.cart, ['VB-115', 'VB-119'], 'cart restored after reload; before reload: ' + JSON.stringify(before) + ' after: ' + JSON.stringify(after));
  await ev(`document.getElementById('cartbtn').click(); document.getElementById('cpn').value='VOLT10'; document.getElementById('cpnbtn').click(); document.getElementById('cname').value='E2E Buyer'; document.getElementById('checkout').click(); return 1`);
  await wait(`document.getElementById('modal').classList.contains('open') && /Order #\\d+ placed/.test(document.getElementById('mbox').innerText)`);
  const r = await ev(`const txt=document.getElementById('mbox').innerText; const o=await fetch('/api/orders',{headers:{authorization:'Bearer '+localStorage.getItem('voltbay_token')}}).then(r=>r.json()); return { txt, server:o[0], cart:Object.keys(S.cart).length }`);
  assert.match(r.txt, new RegExp('Order #' + r.server.id + ' placed')); assert.equal(r.cart, 0);
  assert.ok(r.txt.replace(/,/g, '').includes(String(r.server.total)), 'receipt total ' + r.server.total + ' equals the stored total');
});

test('the Gaming page lists real products and "Add all to cart" fills the cart', async () => {
  await open(); await ev(`document.getElementById('m-gear').click(); await new Promise(r=>setTimeout(r,500)); return 1`);
  const r = await ev(`const cats=[...document.querySelectorAll('.ar-cat')].filter(e=>e.dataset.cat!==undefined).length; const grid=document.querySelectorAll('.ar-hero ~ .grid .mini').length; const setup=document.querySelector('[data-setup]'); const ids=setup.dataset.setup.split(','); setup.click(); await new Promise(r=>setTimeout(r,2500)); return { cats, grid, ids, cart:Object.keys(S.cart).sort(), server:(await fetch('/api/state',{headers:{authorization:'Bearer '+localStorage.getItem('voltbay_token')}}).then(r=>r.json())).cart.map(i=>i.id).sort() }`);
  assert.equal(r.cats, 10); assert.ok(r.grid >= 12); assert.deepEqual(r.cart, [...r.ids].sort()); assert.deepEqual(r.server, [...r.ids].sort(), 'the server cart matches (no overwritten items)');
});

test('admin: hidden and blocked for shoppers, available after admin sign-in, gone after sign-out', async () => {
  await open();
  assert.equal(await ev(`mode('mgr'); await new Promise(r=>setTimeout(r,400)); return document.getElementById('mgr').classList.contains('hide')`), true, 'manager view stays hidden');
  assert.equal(await ev(`return document.getElementById('modal').classList.contains('open') && /Sign in/.test(document.getElementById('mbox').innerText)`), true, 'asks for sign-in');
  assert.equal(await ev(`return typeof window.VBAdmin`), 'undefined', 'manager code is not loaded for shoppers');
  await ev(`document.getElementById('ae').value='admin@example.com'; document.getElementById('ap').value='12345'; document.getElementById('ago').click(); return 1`);
  await wait(`getComputedStyle(document.querySelector('details.adm')).display!=='none' && window.VBAdmin`);
  await ev(`document.getElementById('m-mgr').click(); return 1`);
  await wait(`!document.getElementById('mgr').classList.contains('hide') && document.querySelectorAll('#inv tr').length>=60`);
  const tabs = await ev(`return [...document.querySelectorAll('#subnav .chip')].map(b=>b.textContent)`);
  for (const t of ['Overview', 'Inventory', 'Orders', 'Reviews', 'AI control']) assert.ok(tabs.includes(t), t + ' tab');
  // an inventory edit goes through the server
  const r = await ev(`const inp=document.querySelector('#inv input[data-f=stock][data-id=VB-115]'); const was=+inp.value; inp.value=was+3; inp.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,1500)); const srv=(await fetch('/api/products').then(r=>r.json())).find(p=>p.id==='VB-115').stock; return { was, srv }`);
  assert.equal(r.srv, r.was + 3);
  // CSV import goes to the server, and a repeated row is skipped instead of creating a double
  await ev(`document.getElementById('csvt').value='Test USB hub,Accessories,799,5,2\\nTest USB hub,Accessories,799,5,2\\nBroken row,Nowhere,10,1,1'; document.getElementById('csvgo').click(); return 1`);
  await wait(`/1 imported, 2 skipped/.test(document.getElementById('csvr').innerText)`);
  const hubs = await ev(`return (await fetch('/api/products').then(r=>r.json())).filter(p=>p.name==='Test USB hub').length`);
  assert.equal(hubs, 1, 'imported once, not twice, and saved on the server');
  // sign out returns to a shopper page with no admin menu
  await ev(`document.getElementById('acctbtn').click(); return 1`); await wait(`document.getElementById('aout')`);
  await ev(`document.getElementById('aout').click(); return 1`);
  await sleep(1500); await wait(`document.querySelectorAll('#grid .card').length>0 && getComputedStyle(document.querySelector('details.adm')).display==='none' && typeof window.VBAdmin==='undefined'`);
});

test('reviews: a buyer posts a review in the product window and it shows with a verified-buyer label', async () => {
  await open();
  await ev(`const r=await fetch('/api/register',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+localStorage.getItem('voltbay_token')},body:JSON.stringify({email:'rev@example.com',password:'long-enough-pw'})}).then(r=>r.json()); localStorage.setItem('voltbay_token', r.token); return 1`);
  await open('/', { fresh: false });
  await ev(`addCart('VB-116'); await new Promise(r=>setTimeout(r,1000)); document.getElementById('checkout').click(); return 1`);
  await wait(`/placed/.test(document.getElementById('mbox').innerText)`);
  await ev(`document.getElementById('modal').classList.remove('open'); openV('VB-116'); return 1`);
  await wait(`document.getElementById('rvs')`);
  await ev(`document.getElementById('rvr').value='4'; document.getElementById('rvt').value='Handy'; document.getElementById('rvb').value='Charges my phone twice, small and light.'; document.getElementById('rvs').click(); return 1`);
  await wait(`/Verified buyer/.test(document.getElementById('revs').innerText)`);
  const r = await ev(`return { txt: document.getElementById('revs').innerText, rating: P('VB-116').rating }`);
  assert.match(r.txt, /Handy/); assert.deepEqual(r.rating, { avg: 4, count: 1 });
  await ev(`document.getElementById('modal').classList.remove('open'); return 1`);
  assert.equal(await ev(`return /★★★★☆/.test(document.querySelector('#grid').innerText)`), true, 'the product card shows its stars');
});

test('repairs: a shopper books and tracks one, and the admin sees it and moves it along', async () => {
  await open('/', { fresh: true });
  await ev(`document.getElementById('m-rep').click(); const set=(i,v)=>{document.getElementById(i).value=v}; set('rfn','Asha Rao'); set('rfp','9876543210'); set('rfe','asha@example.com'); set('rfb','Samsung'); set('rfm','Galaxy A54'); set('rfd','Screen cracked after a fall'); set('rft', new Date(Date.now()+2*864e5).toISOString().slice(0,10)); document.querySelector('#repform button[type=submit], #repform .btn').click(); return 1`);
  await wait(`/Your repair ID is RP-\\d+/.test(document.getElementById('repok').innerText)`);
  const ref = await ev(`return document.getElementById('repok').innerText.match(/RP-\\d+/)[0]`);
  await ev(`document.getElementById('trkbtn').click(); return 1`); await wait(`/Request received/.test(document.getElementById('trkres').innerText)`);
  // the admin, in the same browser, sees the booking from the server and updates it
  await ev(`document.getElementById('acctbtn').click(); await new Promise(r=>setTimeout(r,200)); document.getElementById('ae').value='admin@example.com'; document.getElementById('ap').value='12345'; document.getElementById('ago').click(); return 1`);
  await wait(`window.VBAdmin`); await ev(`document.getElementById('m-mgr').click(); return 1`);
  await wait(`!document.getElementById('mgr').classList.contains('hide')`);
  await ev(`[...document.querySelectorAll('#subnav .chip')].find(b=>b.textContent==='Repairs').click(); return 1`);
  await wait(`document.getElementById('repl').innerText.includes(${JSON.stringify(ref)})`);
  await ev(`const sel=document.querySelector('#repl select[data-rs]'); sel.value='Estimate provided'; sel.dispatchEvent(new Event('change',{bubbles:true})); return 1`);
  await wait(`document.querySelector('#repl select[data-rs]').value==='Estimate provided'`);
  const st = await ev(`const r=await fetch('/api/admin/repairs',{headers:{authorization:'Bearer '+localStorage.getItem('voltbay_token')}}).then(r=>r.json()); return r.find(x=>x.ref===${JSON.stringify(ref)}).status`);
  assert.equal(st, 'Estimate provided');
});

test('VoltAI panel answers with product rows that have photos, and a missing server does not break it', async () => {
  await open();
  await ev(`document.getElementById('aibtn').click(); aiSend('best phone under 25000'); return 1`);
  await wait(`document.querySelectorAll('#ailog .pl').length>=1`, 8000);
  assert.equal(await ev(`return document.querySelectorAll('#ailog .pl img.plimg').length>=1`), true);
  assert.match(await ev(`return document.getElementById('ailog').innerText`), /Nothing Phone/);
});

test('mobile width: no horizontal scrolling and the cart still works', async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  try {
    await open();
    assert.equal(await ev(`return document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0);
    await ev(`addCart('VB-115'); return 1`); assert.equal(await ev(`return Object.keys(S.cart).length`), 1);
  } finally { await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); }
});

test('the whole run produced no uncaught page errors', { skip }, () => { assert.deepEqual(errors, []); });
