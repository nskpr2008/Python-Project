import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { searchProducts } from '../lib/ai.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voltbay-test-'));
let seq = 0;
const dbFile = () => path.join(tmp, `t${++seq}.db`);

async function boot(opts = {}) {
  const { server, db } = createApp({ dbFile: opts.dbFile || dbFile(), ai: { key: '', provider: '' }, adminEmail: 'Admin@Example.com', adminPassword: 'correct-horse-battery', ...opts });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { token, body, headers } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  const guest = async () => (await call('POST', '/api/session')).json;
  let closed = false;
  const app = { server, db, base, call, guest, close: () => new Promise(r => { if (closed) return r(); closed = true; server.close(() => { db.close(); r(); }); server.closeAllConnections?.(); }) };
  booted.push(app);
  return app;
}
// A failing assertion must not leave servers running and hang the test process.
const booted = [];
after(async () => { for (const app of booted) await app.close(); });

test('catalogue is complete: details, specs and a real photo for every product', async () => {
  const a = await boot();
  const { json: products } = await a.call('GET', '/api/products');
  assert.ok(products.length >= 30);
  const gaming = products.filter(p => (p.tags || []).includes('gaming-gear'));
  assert.ok(gaming.length >= 12 && gaming.every(p => p.image && p.imageCredit), 'gaming catalogue has photos and credits');
  assert.ok(new Set(gaming.flatMap(p => p.tags.filter(t => t.startsWith('sub:')))).size >= 8, 'gaming sub-categories');
  for (const p of products) {
    assert.ok(p.price > 0 && p.summary && p.description.length > 30, p.id);
    assert.ok(Object.keys(p.specs).length >= 2 && p.highlights.length >= 1, p.id + ' specs');
    assert.ok(p.image && fs.existsSync(path.join('public', p.image)), p.id + ' image file');
    assert.ok(p.imageCredit?.license && p.imageCredit?.author, p.id + ' credit');
    assert.ok(Number.isInteger(p.reorder) && Number.isInteger(p.stock), p.id + ' stock fields');
  }
  assert.equal(new Set(products.map(p => p.id)).size, products.length);
  const one = await a.call('GET', '/api/products/VB-100');
  assert.equal(one.json.brand, 'Nothing'); assert.ok(one.json.related.length > 0);
  assert.equal((await a.call('GET', '/api/products/NOPE')).status, 404);
  await a.close();
});

test('static files: storefront served with security headers; no path traversal or source leaks', async () => {
  const a = await boot();
  const home = await a.call('GET', '/');
  assert.equal(home.status, 200); assert.match(home.text, /VoltBay/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await a.call('GET', '/assets/products/VB-100.jpg')).status, 200);
  for (const bad of ['/..%2fserver.mjs', '/%2e%2e/server.mjs', '/assets/../../server.mjs', '/server.mjs', '/lib/ai.mjs', '/voltai.db', '/data/products.json', '/.env'])
    assert.equal((await a.call('GET', bad)).status, 404, bad);
  assert.equal(home.headers.get('access-control-allow-origin'), null);
  await a.close();
});

test('returning visitor: cart, wishlist and recently viewed persist, also across a server restart', async () => {
  const file = dbFile();
  let a = await boot({ dbFile: file });
  const g = await a.guest();
  assert.equal(g.user.guest, true); assert.equal(g.state.empty, true);
  const put = await a.call('PUT', '/api/state', { token: g.token, body: { cart: [{ id: 'VB-100', qty: 2 }, { id: 'VB-114', qty: 1 }, { id: 'VB-109', qty: 1 }, { id: 'NOPE', qty: 1 }, { id: 'VB-103', qty: 99 }], wish: { 'VB-119': true, NOPE: true }, recent: ['VB-120', 'NOPE'], cmp: ['VB-100'] } });
  assert.equal(put.status, 200);
  const cart = Object.fromEntries(put.json.cart.map(i => [i.id, i.qty]));
  assert.deepEqual(cart, { 'VB-100': 2, 'VB-114': 1, 'VB-103': 2 }, 'unknown/out-of-stock dropped, qty clamped to stock (VB-103 has 2)');
  assert.deepEqual(put.json.wish, { 'VB-119': true }); assert.deepEqual(put.json.recent, ['VB-120']);
  const back = await a.call('GET', '/api/session', { token: g.token });
  assert.deepEqual(back.json.state.cart, put.json.cart);
  await a.close();
  a = await boot({ dbFile: file }); // "the site restarts, the shopper returns next week"
  const again = await a.call('POST', '/api/session', { token: g.token });
  assert.equal(again.status, 200); assert.deepEqual(again.json.state.cart, put.json.cart); assert.equal(again.json.user.id, g.user.id);
  assert.equal((await a.call('GET', '/api/state', { token: 'bogus' })).status, 401);
  await a.close();
});

test('accounts: emails are normalised, guest cart carries over on register and merges on login', async () => {
  const a = await boot();
  const g1 = await a.guest();
  await a.call('PUT', '/api/state', { token: g1.token, body: { cart: [{ id: 'VB-100', qty: 1 }] } });
  const reg = await a.call('POST', '/api/register', { token: g1.token, body: { email: '  Shopper@Example.COM ', password: 'longenough1' } });
  assert.equal(reg.status, 201); assert.equal(reg.json.user.email, 'shopper@example.com'); assert.equal(reg.json.user.id, g1.user.id);
  assert.deepEqual(reg.json.state.cart, [{ id: 'VB-100', qty: 1 }]);
  assert.equal((await a.call('POST', '/api/register', { body: { email: 'SHOPPER@example.com', password: 'longenough1' } })).status, 409);
  const g2 = await a.guest();
  await a.call('PUT', '/api/state', { token: g2.token, body: { cart: [{ id: 'VB-114', qty: 1 }, { id: 'VB-100', qty: 1 }], wish: { 'VB-112': true } } });
  const login = await a.call('POST', '/api/login', { token: g2.token, body: { email: 'SHOPPER@example.com ', password: 'longenough1' } });
  assert.equal(login.status, 200);
  const cart = Object.fromEntries(login.json.state.cart.map(i => [i.id, i.qty]));
  assert.deepEqual(cart, { 'VB-100': 2, 'VB-114': 1 }); assert.deepEqual(login.json.state.wish, { 'VB-112': true });
  assert.equal((await a.call('GET', '/api/state', { token: g2.token })).status, 401, 'merged guest session is gone');
  assert.equal((await a.call('POST', '/api/login', { body: { email: 'shopper@example.com', password: 'wrong-password' } })).status, 401);
  assert.equal((await a.call('POST', '/api/register', { body: { email: 'bad', password: 'longenough1' } })).status, 400);
  assert.equal((await a.call('POST', '/api/register', { body: { email: 'x@y.co', password: 'short' } })).status, 400);
  await a.close();
});

test('admin account from env is case-insensitive; login attempts are throttled', async () => {
  const a = await boot();
  const ok = await a.call('POST', '/api/login', { body: { email: 'admin@example.com', password: 'correct-horse-battery' } });
  assert.equal(ok.status, 200); assert.equal(ok.json.role, 'admin');
  let last;
  for (let i = 0; i < 10; i++) last = await a.call('POST', '/api/login', { body: { email: 'victim@example.com', password: 'wrongwrong' + i } });
  assert.equal(last.status, 429);
  await a.close();
});

test('privileges: customers cannot promote themselves or reach admin routes; admin controls work', async () => {
  const a = await boot();
  const g = await a.guest();
  const reg = await a.call('POST', '/api/register', { token: g.token, body: { email: 'c@example.com', password: 'longenough1' } });
  const t = reg.json.token;
  assert.equal((await a.call('POST', '/api/profile', { token: t, body: { profile: 'admin' } })).status, 403);
  for (const p of ['/api/admin/audit', '/api/admin/tools', '/api/admin/inventory']) assert.equal((await a.call('GET', p, { token: t })).status, 403, p);
  assert.equal((await a.call('POST', '/api/admin/kill', { token: t, body: { enabled: false } })).status, 403);
  assert.equal((await a.call('GET', '/api/admin/audit')).status, 401);
  const adm = (await a.call('POST', '/api/login', { body: { email: 'admin@example.com', password: 'correct-horse-battery' } })).json.token;
  const inv = await a.call('GET', '/api/admin/inventory', { token: adm });
  assert.equal(inv.status, 200); assert.ok(inv.json[0].reorder >= 0);
  assert.equal((await a.call('POST', '/api/admin/kill', { token: adm, body: { enabled: false } })).status, 200);
  const off = await a.call('POST', '/api/ai/chat', { token: t, body: { message: 'hello' } });
  assert.match(off.json.reply, /switched off/);
  await a.call('POST', '/api/admin/kill', { token: adm, body: { enabled: true } });
  assert.equal((await a.call('POST', '/api/admin/tools/add_to_cart', { token: adm, body: { enabled: false } })).status, 200);
  const blocked = await a.call('POST', '/api/ai/chat', { token: t, body: { message: 'add the Nothing Phone (2a) to my cart' } });
  assert.deepEqual(blocked.json.pending, []);
  await a.close();
});

test('recommendations adapt to behaviour and respect stock, cart and budget', async () => {
  const a = await boot();
  const g = await a.guest();
  const cold = (await a.call('GET', '/api/recommendations?limit=6', { token: g.token })).json;
  assert.equal(cold.personalised, false); assert.equal(cold.items.length, 6);
  assert.ok(!cold.items.some(i => i.id === 'VB-109'), 'out-of-stock never recommended');
  for (const id of ['VB-120', 'VB-119', 'VB-100']) await a.call('POST', '/api/events', { token: g.token, body: { type: 'view', id } });
  await a.call('POST', '/api/events', { token: g.token, body: { type: 'search', q: 'phone under 30000' } });
  const warm = (await a.call('GET', '/api/recommendations?limit=6', { token: g.token })).json;
  assert.equal(warm.personalised, true);
  const meta = new Map((await a.call('GET', '/api/products')).json.map(p => [p.id, p]));
  assert.equal(meta.get(warm.items[0].id).cat, 'Phones', 'a phone shopper sees phones first');
  assert.ok(meta.get(warm.items[0].id).price <= 30000 * 1.1, 'and respects the "under 30000" they just searched');
  assert.match(warm.items[0].reason, /looked at|browsing/);
  // Cart: owned items are excluded and compatible accessories rise
  await a.call('PUT', '/api/state', { token: g.token, body: { cart: [{ id: 'VB-119', qty: 1 }] } });
  const cart = (await a.call('GET', '/api/recommendations?limit=8', { token: g.token })).json.items;
  assert.ok(!cart.some(i => i.id === 'VB-119'));
  assert.ok(cart.some(i => /Goes with Apple iPhone 15/.test(i.reason)), 'accessory suggested for the iPhone in the cart');
  // Budget preference
  await a.call('POST', '/api/ai/chat', { token: g.token, body: { message: 'my budget is 20000' } });
  const cheap = (await a.call('GET', '/api/recommendations?limit=3', { token: g.token })).json.items;
  const prices = new Map((await a.call('GET', '/api/products')).json.map(p => [p.id, p.price]));
  assert.ok(cheap.every(i => prices.get(i.id) <= 20000), 'top picks stay within the stated budget');
  // Two shoppers with different interests get different shelves
  const g2 = await a.guest();
  for (const id of ['VB-112', 'VB-113']) await a.call('POST', '/api/events', { token: g2.token, body: { type: 'view', id } });
  const other = (await a.call('GET', '/api/recommendations?limit=4', { token: g2.token })).json.items.map(i => i.id);
  assert.notDeepEqual(other, cheap.map(i => i.id));
  assert.notEqual(meta.get(other[0]).cat, 'Phones', 'a wearables shopper is not shown phones first');
  assert.equal((await a.call('POST', '/api/events', { token: g.token, body: { type: 'hack', id: 'VB-100' } })).status, 400);
  assert.equal((await a.call('POST', '/api/events', { token: g.token, body: { type: 'view' } })).status, 400);
  await a.close();
});

test('VoltAI (offline mode): understands requests, personalises, and cart changes need confirmation', async () => {
  const a = await boot();
  const g = await a.guest();
  const ask = async (message, token = g.token) => (await a.call('POST', '/api/ai/chat', { token, body: { message } })).json;
  const prices = new Map((await a.call('GET', '/api/products')).json.map(p => [p.id, p]));

  let r = await ask('best phone under 25000');
  assert.equal(r.mode, 'demo'); assert.ok(r.products.length >= 1 && r.products.every(p => prices.get(p.id).cat === 'Phones' && p.price <= 25000), JSON.stringify(r.products));
  r = await ask('headphones for travel with noise cancelling'); assert.ok(r.products.length >= 1); assert.ok(r.products.some(p => /Bose|AirPods Max/.test(p.name)));
  r = await ask('compare iPhone 15 and Samsung Galaxy S24 Ultra'); assert.deepEqual(r.products.map(p => p.id).sort(), ['VB-119', 'VB-120']);
  r = await ask('what goes with the Apple iPhone 15?'); assert.ok(r.products.length >= 1 && !r.products.some(p => p.id === 'VB-119'));
  r = await ask('student setup under 60000'); assert.ok(r.products.length >= 2 && r.products.reduce((t, p) => t + p.price, 0) <= 60000 + 20000);
  r = await ask('Tell me about the Xiaomi Smart Band 7'); assert.equal(r.products[0].id, 'VB-112');
  r = await ask('asdkjh qwe'); assert.match(r.reply, /Try:/);
  r = await ask('for daily use which one is better headset or headphones'); assert.match(r.reply, /microphone/); assert.ok(r.products.length >= 1);
  r = await ask('best console under 55000'); assert.ok(r.products.length >= 1 && r.products.every(p => prices.get(p.id).cat === 'Gaming' && p.price <= 55000), JSON.stringify(r.products));
  r = await ask('gaming setup under 90000'); assert.ok(r.products.length >= 2 && r.products.every(p => prices.get(p.id).tags.includes('gaming-gear')));
  r = await ask('ps5 or xbox which is better'); assert.deepEqual(r.products.map(p => p.id).sort(), ['VB-130', 'VB-131']);
  r = await ask('best speaker'); assert.ok(r.products.every(p => p.stock > 0), 'out-of-stock JBL Flip is not offered');

  // Add to cart: must be confirmed by the shopper
  r = await ask('add the Nothing Phone (2a) to my cart');
  assert.equal(r.pending.length, 1); assert.match(r.pending[0].summary, /Nothing Phone \(2a\)/);
  assert.deepEqual((await a.call('GET', '/api/state', { token: g.token })).json.cart, [], 'nothing changes before confirmation');
  const id = r.pending[0].id;
  const other = await a.guest();
  assert.equal((await a.call('POST', `/api/approvals/${id}/confirm`, { token: other.token })).status, 404, "someone else's approval");
  const ok = await a.call('POST', `/api/approvals/${id}/confirm`, { token: g.token });
  assert.equal(ok.status, 200); assert.deepEqual(ok.json.state.cart, [{ id: 'VB-100', qty: 1 }]);
  assert.equal((await a.call('POST', `/api/approvals/${id}/confirm`, { token: g.token })).status, 404, 'cannot be applied twice');
  r = await ask('what is in my cart'); assert.equal(r.products[0].id, 'VB-100');
  r = await ask('add the JBL Flip 4 to my cart'); assert.equal(r.pending.length, 0); assert.match(r.reply, /out of stock/);
  r = await ask('remove the Nothing Phone (2a) from my cart'); assert.equal(r.pending.length, 1);
  assert.equal((await a.call('POST', `/api/approvals/${r.pending[0].id}/reject`, { token: g.token })).json.status, 'rejected');
  assert.equal((await a.call('GET', '/api/state', { token: g.token })).json.cart.length, 1);

  // Preferences are remembered and used
  await ask('I prefer Samsung');
  const mem = (await a.call('GET', '/api/memory', { token: g.token })).json; assert.deepEqual(mem.map(m => m.k), ['brand']);
  assert.equal((await a.call('POST', '/api/ai/chat', { token: g.token, body: { message: 'x'.repeat(1001) } })).status, 400);
  assert.equal((await a.call('POST', '/api/ai/chat', { body: { message: 'hi' } })).status, 401);
  await a.close();
});

test('checkout is atomic: stock is decremented on the server, the cart is cleared, orders feed recommendations', async () => {
  const a = await boot();
  const g = await a.guest();
  const stockOf = async id => (await a.call('GET', `/api/products/${id}`)).json.stock;
  const before = await stockOf('VB-103'); // 2 in stock
  assert.equal((await a.call('POST', '/api/checkout', { token: g.token, body: {} })).status, 400, 'empty cart');
  await a.call('PUT', '/api/state', { token: g.token, body: { cart: [{ id: 'VB-103', qty: 2 }, { id: 'VB-115', qty: 1 }] } });
  // someone else buys the last laptops first
  const rival = await a.guest();
  await a.call('PUT', '/api/state', { token: rival.token, body: { cart: [{ id: 'VB-103', qty: 2 }] } });
  assert.equal((await a.call('POST', '/api/checkout', { token: rival.token, body: { name: 'Rival' } })).status, 201);
  const lost = await a.call('POST', '/api/checkout', { token: g.token, body: { name: 'Late' } });
  assert.equal(lost.status, 409); assert.match(lost.json.error, /only 0 left/);
  assert.equal(await stockOf('VB-115'), 4, 'a failed checkout must not decrement anything');
  assert.equal((await a.call('GET', '/api/state', { token: g.token })).json.cart.length, 2, 'a failed checkout leaves the cart untouched');
  const resync = await a.call('PUT', '/api/state', { token: g.token, body: { cart: [{ id: 'VB-103', qty: 2 }, { id: 'VB-115', qty: 1 }] } });
  assert.deepEqual(resync.json.cart, [{ id: 'VB-115', qty: 1 }], 'the next sync drops what is no longer in stock');
  const ok = await a.call('POST', '/api/checkout', { token: g.token, body: { name: 'Asha' } });
  assert.equal(ok.status, 201); assert.equal(ok.json.order.total, 399); assert.equal(ok.json.state.cart.length, 0);
  assert.equal(await stockOf('VB-115'), 3); assert.equal(before, 2); assert.equal(await stockOf('VB-103'), 0);
  assert.equal((await a.call('GET', '/api/orders', { token: g.token })).json[0].name, 'Asha');
  await a.close();
});

test('VoltAI cannot be tricked into admin tools or arbitrary arguments', async () => {
  const a = await boot();
  const g = await a.guest();
  const { exec } = await import('../lib/ai.mjs');
  const u = { ...a.db.prepare('select * from users where id=?').get(g.user.id), profile: 'customer' };
  assert.match(exec(a.db, 'low_stock_report', {}, u).error, /not permitted/);
  assert.match(exec(a.db, 'add_to_cart', { product_id: 'VB-100', qty: 1000 }, u).error, /out of range/);
  assert.match(exec(a.db, 'search_products', { query: 'x', sql: 'drop table' }, u).error, /unexpected argument/);
  assert.match(exec(a.db, 'nope', {}, u).error, /unknown tool/);
  assert.equal(a.db.prepare('select count(*) c from audit where ok=0').get().c, 4, 'failures are audited');
  await a.close();
});

test('request hardening: bad JSON, oversized bodies, CORS only for the exact configured origin', async () => {
  const a = await boot({ allowedOrigin: 'https://shop.example' });
  assert.equal((await a.call('POST', '/api/session', { body: '{not json' })).status, 400);
  assert.equal((await a.call('POST', '/api/login', { body: '[1,2]' })).status, 400);
  assert.equal((await a.call('POST', '/api/login', { body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(70000) }) })).status, 413);
  const ok = await a.call('GET', '/api/status', { headers: { origin: 'https://shop.example' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://shop.example');
  const no = await a.call('GET', '/api/status', { headers: { origin: 'https://evil.example' } });
  assert.equal(no.headers.get('access-control-allow-origin'), null);
  await a.close();
});

test('catalogue search ranks sensibly', async () => {
  const a = await boot();
  const names = q => searchProducts(a.db, { query: q, in_stock: false }).map(p => p.name);
  assert.match(names('airpods')[0], /AirPods/);
  assert.ok(names('samsung phone').slice(0, 3).every(n => /Galaxy/.test(n)) && names('samsung phone').some(n => /Galaxy S24 Ultra/.test(n)), 'Samsung phones come first');
  assert.ok(names('smart watch').some(n => /Watch/.test(n)));
  assert.ok(names('usb c charger')[0].match(/charger|cable/i));
  await a.close();
});

test('admin panel: manager data and code reach only a signed-in admin; edits are server-side and survive restarts', async () => {
  const file = dbFile();
  const a = await boot({ dbFile: file, adminEmail: 'admin@example.com', adminPassword: '12345' }); // short demo password is allowed on loopback
  const login = await a.call('POST', '/api/login', { body: { email: 'Admin@Example.com', password: '12345' } });
  assert.equal(login.status, 200); assert.equal(login.json.user.role, 'admin');
  const adm = login.json.token, g = (await a.guest()).token;
  assert.equal((await a.call('POST', '/api/register', { body: { email: 'x@example.com', password: '12345' } })).status, 400, 'new accounts still need 8+ characters');
  for (const p of ['/api/admin/orders', '/api/admin/overview', '/api/admin/files', '/api/admin/ai', '/api/admin/panel.js']) {
    assert.equal((await a.call('GET', p)).status, 401, p + ' anonymous');
    assert.equal((await a.call('GET', p, { token: g })).status, 403, p + ' guest');
    assert.equal((await a.call('GET', p, { token: adm })).status, 200, p + ' admin');
  }
  const panel = await a.call('GET', '/api/admin/panel.js', { token: adm }); assert.match(panel.text, /VBAdmin/);
  assert.equal((await a.call('GET', '/admin/panel.js')).status, 404, 'panel code is not a public static file');
  assert.equal((await a.call('GET', '/data/project-files.json')).status, 404);
  assert.equal((await a.call('PUT', '/api/admin/products/VB-100', { token: g, body: { price: 1 } })).status, 403);
  assert.equal((await a.call('POST', '/api/admin/counter-sale', { token: g, body: { items: [{ id: 'VB-100', qty: 1 }] } })).status, 403);
  assert.throws(() => createApp({ dbFile: dbFile(), host: '0.0.0.0', adminEmail: 'a@example.com', adminPassword: '12345' }), /at least 12/);

  // inventory edits
  let r = await a.call('PUT', '/api/admin/products/VB-100', { token: adm, body: { price: 22999, stock: 20, reorder: 3 } }); assert.equal(r.status, 200); assert.equal(r.json.price, 22999);
  assert.equal((await a.call('PUT', '/api/admin/products/VB-100', { token: adm, body: { price: -5 } })).status, 400);
  assert.equal((await a.call('PUT', '/api/admin/products/VB-100', { token: adm, body: { stock: 1.5 } })).status, 400);
  r = await a.call('POST', '/api/admin/products', { token: adm, body: { name: 'Test cable', cat: 'Accessories', price: 299, stock: 7, reorder: 2 } }); assert.equal(r.status, 201); const newId = r.json.id; assert.match(newId, /^VB-9\d\d$/);
  assert.equal((await a.call('POST', '/api/admin/products', { token: adm, body: { name: 'Bad', cat: 'Nope', price: 1 } })).status, 400);
  assert.equal((await a.call('DELETE', '/api/admin/products/VB-100', { token: adm })).status, 409, 'catalogue products cannot be deleted from the panel');

  // counter sale + order status
  r = await a.call('POST', '/api/admin/counter-sale', { token: adm, body: { items: [{ id: newId, qty: 2 }], name: 'Walk-in' } }); assert.equal(r.status, 201); assert.equal(r.json.order.total, 598);
  assert.equal((await a.call('POST', '/api/admin/counter-sale', { token: adm, body: { items: [{ id: newId, qty: 50 }] } })).status, 409);
  const orders = (await a.call('GET', '/api/admin/orders', { token: adm })).json;
  assert.equal(orders[0].src, 'Counter'); assert.equal(orders[0].status, 'Completed');
  assert.equal((await a.call('POST', `/api/admin/orders/${orders[0].id}/status`, { token: adm, body: { status: 'Shipped' } })).status, 200);
  assert.equal((await a.call('POST', `/api/admin/orders/${orders[0].id}/status`, { token: adm, body: { status: 'Bogus' } })).status, 400);
  const ov = (await a.call('GET', '/api/admin/overview', { token: adm })).json; assert.equal(ov.orders, 1); assert.equal(ov.revenue, 598);
  assert.ok((await a.call('GET', '/api/admin/audit', { token: adm })).json.some(x => x.tool === 'admin_counter_sale'));
  await a.close();

  // restart on the same database: admin edits survive the catalogue sync
  const b = await boot({ dbFile: file, adminEmail: 'admin@example.com', adminPassword: '12345' });
  const prods = (await b.call('GET', '/api/products')).json;
  assert.equal(prods.find(p => p.id === 'VB-100').price, 22999, 'edited price kept');
  assert.equal(prods.find(p => p.id === newId).stock, 5, 'admin-added product kept');
  const adm2 = (await b.call('POST', '/api/login', { body: { email: 'admin@example.com', password: '12345' } })).json.token;
  assert.equal((await b.call('DELETE', '/api/admin/products/' + newId, { token: adm2 })).status, 200);
});

test('VoltAI with a model provider (local fake of the Gemini API): tools run, usage is capped, failures fall back offline', async () => {
  const seen = [];
  const fake = http.createServer((req, res) => {
    let s = ''; req.on('data', c => s += c); req.on('end', () => {
      const body = JSON.parse(s || '{}'); seen.push({ url: req.url, key: req.headers['x-goog-api-key'], body });
      const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.includes('retired-model')) return reply(404, { error: { message: 'This model is no longer available to new users.' } });
      if (req.url.includes('broken-model')) return reply(500, { error: { message: 'boom' } });
      const last = body.contents.at(-1);
      if (last.parts.some(p => p.functionResponse)) return reply(200, { candidates: [{ content: { role: 'model', parts: [{ text: '**Two** phones fit: the Nothing Phone (2a) is the best all-rounder.' }] } }] });
      reply(200, { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search_products', args: { query: 'phone', max_price: 25000 } } }] } }] });
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  try {
    const a = await boot({ ai: { provider: 'gemini', key: 'test-key', model: 'good-model', base, dailyLimit: 2, userDaily: 25 } });
    const g = await a.guest();
    const ask = async (message, token = g.token) => (await a.call('POST', '/api/ai/chat', { token, body: { message } })).json;
    let r = await ask('best phone under 25000');
    assert.equal(r.mode, 'real'); assert.match(r.reply, /Two phones fit/); assert.ok(!r.reply.includes('**'), 'markdown stripped');
    assert.ok(r.products.length >= 1 && r.products.every(p => p.price <= 25000), 'tool results become product cards');
    assert.equal(seen.length, 2); assert.equal(seen[0].key, 'test-key'); assert.match(seen[0].url, /good-model:generateContent/);
    assert.ok(seen[0].body.tools[0].functionDeclarations.some(d => d.name === 'search_products'));
    assert.ok(!seen[0].body.tools[0].functionDeclarations.some(d => d.name === 'low_stock_report'), 'admin tools are not offered to shoppers');
    r = await ask('headphones for travel'); // the store-wide daily cap (2) is spent
    assert.equal(r.mode, 'demo'); assert.match(r.reply, /allowance/); assert.equal(seen.length, 2, 'no request is sent once the cap is reached');
    const adm = (await a.call('POST', '/api/login', { body: { email: 'admin@example.com', password: 'correct-horse-battery' } })).json.token;
    assert.equal((await a.call('GET', '/api/admin/ai', { token: adm })).json.used, 2);
    await a.close();

    const b = await boot({ ai: { provider: 'gemini', key: 'k', model: 'retired-model', fallbackModel: 'good-model', base, dailyLimit: 50 } });
    r = (await b.call('POST', '/api/ai/chat', { token: (await b.guest()).token, body: { message: 'best phone under 25000' } })).json;
    assert.equal(r.mode, 'real', 'a refused model falls back to the backup model'); assert.match(seen.at(-1).url, /good-model/);

    const c = await boot({ ai: { provider: 'gemini', key: 'k', model: 'broken-model', base, dailyLimit: 50 } });
    r = (await c.call('POST', '/api/ai/chat', { token: (await c.guest()).token, body: { message: 'best phone under 25000' } })).json;
    assert.equal(r.mode, 'demo'); assert.match(r.reply, /Nothing Phone/); assert.ok(r.products.length >= 1, 'a provider failure still gets a useful offline answer');
    // after a failure the model is skipped for a while, so the next shopper is answered instantly without another provider call
    const hitsBefore = seen.length;
    r = (await c.call('POST', '/api/ai/chat', { token: (await c.guest()).token, body: { message: 'best phone under 25000' } })).json;
    assert.equal(r.mode, 'demo'); assert.match(r.reply, /busy/); assert.equal(seen.length, hitsBefore, 'no provider request while the model is paused');
  } finally { fake.close(); fake.closeAllConnections?.(); }
});

test('order totals: deals, coupon and add-ons are priced on the server and reach the admin revenue', async () => {
  const a = await boot();
  const g = await a.guest();
  await a.call('PUT', '/api/state', { token: g.token, body: { cart: [{ id: 'VB-100', qty: 1 }, { id: 'VB-115', qty: 1 }], coupon: 'volt10', addons: ['war', 'del', 'bogus'] } });
  const st = (await a.call('GET', '/api/state', { token: g.token })).json; assert.deepEqual(st.addons.sort(), ['del', 'war']);
  // subtotal 23,999 + 399 = 24,398; deal on VB-100 10% = 2,400; coupon 10% of subtotal = 2,440; free delivery above 999; warranty 499
  const r = await a.call('POST', '/api/checkout', { token: g.token, body: { name: 'Priya' } });
  assert.equal(r.status, 201); assert.equal(r.json.order.total, 24398 - 2440 - 2400 + 499);
  assert.equal(r.json.order.pricing.subtotal, 24398); assert.equal(r.json.order.pricing.coupon, 'VOLT10');
  const after = (await a.call('GET', '/api/state', { token: g.token })).json; assert.equal(after.coupon, ''); assert.deepEqual(after.addons, [], 'coupon and add-ons are used up by the order');
  const adm = (await a.call('POST', '/api/login', { body: { email: 'admin@example.com', password: 'correct-horse-battery' } })).json.token;
  assert.equal((await a.call('GET', '/api/admin/overview', { token: adm })).json.revenue, r.json.order.total, 'admin revenue is what the customer paid');
  // a bad coupon is ignored, no discount
  await a.call('PUT', '/api/state', { token: g.token, body: { cart: [{ id: 'VB-115', qty: 1 }], coupon: 'FREE100' } });
  assert.equal((await a.call('POST', '/api/checkout', { token: g.token, body: {} })).json.order.total, 399);
});

test('reviews: only signed-in buyers can review, one per product, ratings are real averages, admin can remove', async () => {
  const a = await boot();
  const g = await a.guest();
  const rv = (id, token, body) => a.call('POST', `/api/products/${id}/reviews`, { token, body });
  let r = (await a.call('GET', '/api/products/VB-115/reviews')).json; assert.equal(r.summary.count, 0); assert.equal(r.canReview, false);
  assert.equal((await rv('VB-115', g.token, { rating: 5, body: 'Great cable, works well.' })).status, 403, 'a guest cannot review');
  const reg = await a.call('POST', '/api/register', { token: g.token, body: { email: 'priya@example.com', password: 'long-enough-pw' } });
  assert.equal(reg.status, 201); const tk = reg.json.token;
  assert.equal((await rv('VB-115', tk, { rating: 5, body: 'Great cable, works well.' })).status, 403, 'not bought yet');
  await a.call('PUT', '/api/state', { token: tk, body: { cart: [{ id: 'VB-115', qty: 1 }] } });
  assert.equal((await a.call('POST', '/api/checkout', { token: tk, body: { name: 'Priya' } })).status, 201);
  assert.equal((await a.call('GET', '/api/products/VB-115/reviews', { token: tk })).json.canReview, true);
  assert.equal((await rv('VB-115', tk, { rating: 6, body: 'Great cable, works well.' })).status, 400);
  assert.equal((await rv('VB-115', tk, { rating: 4, body: 'short' })).status, 400);
  assert.equal((await rv('VB-100', tk, { rating: 4, body: 'I never bought this phone.' })).status, 403, 'only the product that was bought');
  assert.equal((await rv('VB-115', tk, { rating: 4, title: 'Solid', body: '<b>Works</b> well for the price.' })).status, 201);
  assert.equal((await rv('VB-115', tk, { rating: 5, title: 'Better now', body: 'Updated: still great after a month.' })).status, 201, 'a second post edits the first');
  r = (await a.call('GET', '/api/products/VB-115/reviews', { token: tk })).json;
  assert.equal(r.summary.count, 1); assert.equal(r.summary.avg, 5); assert.equal(r.reviews[0].mine, true); assert.equal(r.reviews[0].name, 'Priya');
  const prod = (await a.call('GET', '/api/products')).json.find(p => p.id === 'VB-115'); assert.deepEqual(prod.rating, { avg: 5, count: 1 });
  assert.equal((await a.call('GET', '/api/products')).json.find(p => p.id === 'VB-100').rating, null, 'no reviews, no rating');
  const adm = (await a.call('POST', '/api/login', { body: { email: 'admin@example.com', password: 'correct-horse-battery' } })).json.token;
  assert.equal((await a.call('GET', '/api/admin/reviews', { token: tk })).status, 403);
  assert.equal((await a.call('DELETE', `/api/admin/reviews/${r.reviews[0].id}`, { token: adm })).status, 200);
  assert.equal((await a.call('GET', '/api/products/VB-115/reviews')).json.summary.count, 0);
});

test('VoltAI: order tracking, and general answers are cached while personal ones are not', async () => {
  let hits = 0;
  const fake = http.createServer((req, res) => {
    let s = ''; req.on('data', c => s += c); req.on('end', () => {
      hits++; res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'A headset has a mic; headphones are for music.' }] } }] }));
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  try {
    const a = await boot({ ai: { provider: 'gemini', key: 'k', model: 'm', base: `http://127.0.0.1:${fake.address().port}`, dailyLimit: 50, userDaily: 50 } });
    const g1 = await a.guest(), g2 = await a.guest();
    const ask = async (message, token) => (await a.call('POST', '/api/ai/chat', { token, body: { message } })).json;
    let r = await ask('which is better for gaming headset or headphones', g1.token); assert.equal(r.mode, 'real'); assert.equal(hits, 1);
    r = await ask('Which is better for gaming: headset or headphones?', g2.token); assert.match(r.reply, /headset has a mic/); assert.equal(hits, 1, 'a second shopper asking the same general question reuses the answer');
    await ask('which is better for my gaming budget headset or headphones', g1.token); assert.equal(hits, 2, 'personal wording is never cached');
    await ask('what about cheaper ones', g1.token); assert.equal(hits, 3, 'follow-ups are never cached');
    const adm = (await a.call('POST', '/api/login', { body: { email: 'admin@example.com', password: 'correct-horse-battery' } })).json.token;
    const u = (await a.call('GET', '/api/admin/ai', { token: adm })).json; assert.equal(u.used, 3); assert.equal(u.cacheHits, 1);
    await a.close();
    // order tracking (offline assistant)
    const b = await boot(); const t = (await b.guest()).token;
    const say = async m => (await b.call('POST', '/api/ai/chat', { token: t, body: { message: m } })).json.reply;
    assert.match(await say('where is my order'), /no orders yet/);
    await b.call('PUT', '/api/state', { token: t, body: { cart: [{ id: 'VB-115', qty: 1 }] } });
    const o = (await b.call('POST', '/api/checkout', { token: t, body: {} })).json.order;
    assert.match(await say('track my order'), new RegExp('#' + o.id + ' .*Pending'));
    assert.equal((await b.call('GET', '/api/orders', { token: t })).json[0].status, 'Pending');
  } finally { fake.close(); fake.closeAllConnections?.(); }
});

test('repairs: bookings are stored on the server, tracking is private, and only the admin can update them', async () => {
  const a = await boot();
  const g = (await a.guest()).token, other = (await a.guest()).token;
  const when = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  const good = { name: 'Asha Rao', phone: '9876543210', email: 'asha@example.com', cat: 'Smartphone', brand: 'Samsung', model: 'Galaxy A54', prob: 'Screen cracked after a fall', pref: when, svc: 'Screen replacement', pick: 'Store drop-off' };
  const book = (b, t = g) => a.call('POST', '/api/repairs', { token: t, body: b });
  assert.equal((await a.call('POST', '/api/repairs', { body: good })).status, 401);
  for (const bad of [{ name: 'A' }, { phone: '12345' }, { email: 'nope' }, { brand: '' }, { prob: 'short' }, { pref: '2001-01-01' }]) assert.equal((await book({ ...good, ...bad })).status, 400, JSON.stringify(bad));
  const r = await book(good); assert.equal(r.status, 201); assert.match(r.json.ref, /^RP-1\d{3}$/);
  assert.equal((await a.call('GET', `/api/repairs/${r.json.ref}`, { token: g })).json.status, 'Request received', 'the booking session can track it');
  assert.equal((await a.call('GET', `/api/repairs/${r.json.ref}`, { token: other })).status, 404, 'another shopper cannot see it');
  assert.equal((await a.call('GET', `/api/repairs/${r.json.ref}?phone=0000`, { token: other })).status, 404);
  const t = await a.call('GET', `/api/repairs/${r.json.ref}?phone=3210`, { token: other }); assert.equal(t.status, 200); assert.equal(t.json.device, 'Samsung Galaxy A54'); assert.ok(!('phone' in t.json) && !('email' in t.json), 'no personal data in the tracking answer');
  assert.equal((await a.call('GET', '/api/admin/repairs', { token: g })).status, 403);
  const adm = (await a.call('POST', '/api/login', { body: { email: 'admin@example.com', password: 'correct-horse-battery' } })).json.token;
  assert.equal((await a.call('GET', '/api/admin/repairs', { token: adm })).json[0].phone, '9876543210');
  assert.equal((await a.call('PUT', `/api/admin/repairs/${r.json.ref}`, { token: g, body: { status: 'Completed' } })).status, 403);
  assert.equal((await a.call('PUT', `/api/admin/repairs/${r.json.ref}`, { token: adm, body: { status: 'Bogus' } })).status, 400);
  assert.equal((await a.call('PUT', `/api/admin/repairs/${r.json.ref}`, { token: adm, body: { status: 'Estimate provided', est: 3500, note: 'Panel ordered' } })).status, 200);
  const u = (await a.call('GET', `/api/repairs/${r.json.ref}`, { token: g })).json; assert.equal(u.status, 'Estimate provided'); assert.equal(u.step, 4); assert.equal(u.est, 3500); assert.equal(u.note, 'Panel ordered');
});

test('set_budget tool: validated, remembered, listed in the admin AI tools and offered to the model', async () => {
  const a = await boot();
  const g = (await a.guest()).token, adm = (await a.call('POST', '/api/login', { body: { email: 'admin@example.com', password: 'correct-horse-battery' } })).json.token;
  const tool = (await a.call('GET', '/api/admin/tools', { token: adm })).json.find(t => t.name === 'set_budget');
  assert.ok(tool && tool.memory && tool.enabled, 'listed for the admin AI control tab');
  await a.call('POST', '/api/ai/chat', { token: g, body: { message: 'my budget is 35000' } });
  assert.deepEqual((await a.call('GET', '/api/memory', { token: g })).json.find(m => m.k === 'budget'), { k: 'budget', v: '35000' });
  const rec = (await a.call('GET', '/api/recommendations?limit=6', { token: g })).json.items, price = new Map((await a.call('GET', '/api/products')).json.map(p => [p.id, p.price]));
  assert.ok(rec.every(i => price.get(i.id) <= 35000), 'recommendations respect the saved budget');
  // the tool can be switched off in the admin panel
  await a.call('POST', '/api/admin/tools/set_budget', { token: adm, body: { enabled: false } });
  await a.call('POST', '/api/ai/chat', { token: g, body: { message: 'my budget is 90000' } });
  assert.equal((await a.call('GET', '/api/memory', { token: g })).json.find(m => m.k === 'budget').v, '35000', 'a switched-off tool changes nothing');
});

test('doubles are prevented: repeated events, repeated repair bookings, same-named products, idle guests', async () => {
  const file = dbFile();
  const a = await boot({ dbFile: file });
  const g = (await a.guest()).token, adm = (await a.call('POST', '/api/login', { body: { email: 'admin@example.com', password: 'correct-horse-battery' } })).json.token;
  // a double click records one event
  for (let i = 0; i < 3; i++) await a.call('POST', '/api/events', { token: g, body: { type: 'cart', id: 'VB-101' } });
  assert.equal(a.db.prepare("select count(*) n from events where type='cart' and product_id='VB-101'").get().n, 1);
  // a double-submitted repair booking returns the same reference
  const when = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  const body = { name: 'Asha Rao', phone: '9876543210', email: 'asha@example.com', cat: 'Smartphone', brand: 'Samsung', model: 'Galaxy A54', prob: 'Screen cracked after a fall', pref: when, svc: 'Screen replacement', pick: 'Store drop-off' };
  const r1 = await a.call('POST', '/api/repairs', { token: g, body }), r2 = await a.call('POST', '/api/repairs', { token: g, body });
  assert.equal(r1.status, 201); assert.equal(r2.status, 200); assert.equal(r2.json.ref, r1.json.ref); assert.equal(r2.json.duplicate, true);
  assert.equal(a.db.prepare('select count(*) n from repairs').get().n, 1);
  // two products cannot share a name (any capitalisation), even through a double click
  const add = name => a.call('POST', '/api/admin/products', { token: adm, body: { name, cat: 'Accessories', price: 299, stock: 3, reorder: 1 } });
  assert.equal((await add('Test cable XL')).status, 201);
  assert.equal((await add('test CABLE xl')).status, 409);
  assert.equal((await add('Nothing Phone (2a)')).status, 409, 'catalogue names are protected too');
  // idle guests are cleaned up on the next start; guests who left a cart stay
  const idle = (await a.guest()).token, keeper = (await a.guest()).token;
  await a.call('PUT', '/api/state', { token: keeper, body: { cart: [{ id: 'VB-115', qty: 1 }] } });
  const before = a.db.prepare("select count(*) n from users where role='guest'").get().n;
  a.db.prepare('update sessions set exp=0').run(); // every session has expired
  await a.close();
  const b = await boot({ dbFile: file });
  const left = b.db.prepare("select count(*) n from users where role='guest'").get().n;
  assert.ok(left < before && left >= 1, `idle guests removed (${before} -> ${left}), the one with a cart kept`);
  assert.equal(b.db.prepare("select count(*) n from carts").get().n, 1);
});

test('cleanup', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir; the OS clears it eventually */ } });
