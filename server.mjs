// VoltBay server: storefront, catalogue, persistent shopper sessions, recommendations and the VoltAI assistant.
// Requires Node.js 22.5+ (node:sqlite). Configuration is read from environment variables (see .env.example).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, syncCatalogue, allProducts, normEmail, hashPw, checkPw, tokenHash } from './lib/db.mjs';
import { exec, chat, getCart, setCart, pendingRow, aiUsage, TOOLS, LEVEL } from './lib/ai.mjs';
import { recommend, related } from './lib/recommend.mjs';
import { priceOrder, ADDONS } from './lib/pricing.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Private settings live in .env (git-ignored, outside public/, so it is never served). Real environment variables win.
if (!process.env.NODE_TEST_CONTEXT) try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file: use the environment as it is */ }
const E = process.env;
const PUBLIC = path.join(ROOT, 'public');
const PROVIDER = (E.AI_PROVIDER || (E.GEMINI_API_KEY ? 'gemini' : E.ANTHROPIC_API_KEY ? 'anthropic' : '')).toLowerCase();
const KEY = (PROVIDER === 'gemini' ? E.GEMINI_API_KEY : PROVIDER === 'anthropic' ? E.ANTHROPIC_API_KEY : '') || '';
const MODEL = E.AI_MODEL || (PROVIDER === 'anthropic' ? 'claude-sonnet-5-5' : 'gemini-3.5-flash-lite');
const BASE = (E.AI_BASE_URL || (PROVIDER === 'anthropic' ? 'https://api.anthropic.com' : 'https://generativelanguage.googleapis.com')).replace(/\/+$/, '');
const AI_CFG = { provider: PROVIDER, key: KEY, model: MODEL, fallbackModel: E.AI_FALLBACK_MODEL || (PROVIDER === 'gemini' ? 'gemini-3.1-flash-lite' : ''), base: BASE, dailyLimit: +E.AI_DAILY_LIMIT || 200, userDaily: +E.AI_USER_DAILY || 25, perMinute: 10 };
const REPAIR_STATUSES = ['Request received', 'Inspection pending', 'Under diagnosis', 'Estimate provided', 'Repair approved', 'Repair in progress', 'Ready for collection', 'Completed', 'Cancelled'];
const LOOPBACK =h => ['127.0.0.1', 'localhost', '::1', ''].includes(h || '');
const DAY = 864e5;
const SESSION_MS = 90 * DAY;

class HttpError extends Error { constructor(c, m) { super(m); this.c = c; } }
const fail = (c, m) => { throw new HttpError(c, m); };

export function createApp(opts = {}) {
  const db = openDb(opts.dbFile || E.DB_FILE || path.join(ROOT, 'voltai.db'));
  syncCatalogue(db);
  db.prepare("insert or ignore into settings values('ai_enabled','1')").run();
  const one = (s, ...a) => db.prepare(s).get(...a), all = (s, ...a) => db.prepare(s).all(...a), run = (s, ...a) => db.prepare(s).run(...a);
  const productIds = () => new Set(all('select id from products').map(r => r.id));
  const aiCfg = opts.ai ? { ...AI_CFG, ...opts.ai } : AI_CFG;

  // ---- users and sessions ----
  function mkUser(email, pw, role = 'customer') {
    const salt = crypto.randomBytes(16).toString('hex'), now = Date.now();
    return Number(run('insert into users(email,hash,salt,role,profile,created,last_seen) values(?,?,?,?,?,?,?)',
      email, pw ? hashPw(pw, salt) : null, pw ? salt : null, role, role === 'admin' ? 'admin' : 'customer', now, now).lastInsertRowid);
  }
  function newSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    run('insert into sessions values(?,?,?)', tokenHash(token), userId, Date.now() + SESSION_MS);
    return token;
  }
  const adminEmail = normEmail(opts.adminEmail ?? E.ADMIN_EMAIL), adminPw = opts.adminPassword ?? E.ADMIN_PASSWORD;
  if (adminEmail && adminPw) {
    // A short password is tolerated only for a demo that is reachable from this computer alone.
    if (adminPw.length < 12 && !LOOPBACK(opts.host ?? E.HOST)) throw new Error('ADMIN_PASSWORD must be at least 12 characters when HOST is not 127.0.0.1');
    const ex = one('select * from users where email=?', adminEmail);
    if (!ex) mkUser(adminEmail, adminPw, 'admin');
    else { // keep .env as the source of truth for the admin account: make sure it is an admin and the password matches
      const salt = crypto.randomBytes(16).toString('hex');
      if (ex.role !== 'admin' || !checkPw(adminPw, ex.salt, ex.hash)) run("update users set role='admin', profile='admin', hash=?, salt=? where id=?", hashPw(adminPw, salt), salt, ex.id);
    }
  }
  run('delete from sessions where exp < ?', Date.now());
  // Every first visit creates an anonymous guest. Remove guests whose session has expired and who left nothing behind (no cart, order or repair).
  for (const { id } of all("select id from users u where role='guest' and not exists(select 1 from sessions s where s.user_id=u.id) and not exists(select 1 from carts c where c.user_id=u.id) and not exists(select 1 from orders o where o.user_id=u.id) and not exists(select 1 from repairs r where r.user_id=u.id)")) {
    for (const t of ['events', 'user_state', 'memory', 'convo']) run(`delete from ${t} where user_id=?`, id);
    run('delete from users where id=?', id);
  }

  function userFrom(req) {
    const tk = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tk) return null;
    const s = one('select * from sessions where token_hash=? and exp>?', tokenHash(tk), Date.now());
    if (!s) return null;
    const u = one('select * from users where id=?', s.user_id);
    if (!u) return null;
    if (Date.now() - u.last_seen > 36e5) { run('update users set last_seen=? where id=?', Date.now(), u.id); run('update sessions set exp=? where token_hash=?', Date.now() + SESSION_MS, s.token_hash); }
    return u;
  }

  // ---- throttling (in memory, per process) ----
  const buckets = new Map();
  const hit = (key, max, ms) => {
    const n = Date.now(), a = (buckets.get(key) || []).filter(t => n - t < ms);
    a.push(n); buckets.set(key, a);
    if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.some(t => n - t < ms)) buckets.delete(k);
    return a.length > max;
  };
  const limit = (key, max, ms, msg = 'too many requests, slow down') => { if (hit(key, max, ms)) fail(429, msg); };

  // ---- state helpers ----
  const getState = uid => {
    const row = one('select data from user_state where user_id=?', uid);
    const s = row ? JSON.parse(row.data) : {};
    return { wish: s.wish || {}, recent: s.recent || [], cmp: s.cmp || [], coupon: s.coupon || '', addons: s.addons || [] };
  };
  const putState = (uid, s) => run('insert or replace into user_state values(?,?,?)', uid, JSON.stringify(s), Date.now());
  const fullState = uid => {
    const s = getState(uid), cart = getCart(db, uid);
    return { cart, ...s, empty: !cart.length && !Object.keys(s.wish).length && !s.recent.length && !s.cmp.length };
  };
  function cleanState(body, ids) {
    const out = {};
    if (body.wish !== undefined) { if (typeof body.wish !== 'object' || !body.wish || Array.isArray(body.wish)) fail(400, 'wish must be an object'); out.wish = Object.fromEntries(Object.entries(body.wish).filter(([k, v]) => v && ids.has(k)).slice(0, 100).map(([k]) => [k, true])); }
    for (const k of ['recent', 'cmp']) if (body[k] !== undefined) { if (!Array.isArray(body[k])) fail(400, k + ' must be a list'); out[k] = body[k].filter(x => typeof x === 'string' && ids.has(x)).slice(0, k === 'recent' ? 6 : 4); }
    if (body.coupon !== undefined) out.coupon = typeof body.coupon === 'string' ? body.coupon.slice(0, 20) : '';
    if (body.addons !== undefined) { if (!Array.isArray(body.addons)) fail(400, 'addons must be a list'); out.addons = [...new Set(body.addons.filter(k => typeof k === 'string' && ADDONS[k]))]; }
    return out;
  }
  function mergeGuest(guestId, userId) {
    if (guestId === userId) return;
    const stock = new Map(all('select id, stock from products').map(r => [r.id, r.stock]));
    const merged = new Map(getCart(db, userId).map(i => [i.id, i.qty]));
    for (const i of getCart(db, guestId)) merged.set(i.id, Math.min((merged.get(i.id) || 0) + i.qty, stock.get(i.id) || 0, 20));
    setCart(db, userId, [...merged].map(([id, qty]) => ({ id, qty })));
    const a = getState(userId), b = getState(guestId);
    putState(userId, { wish: { ...b.wish, ...a.wish }, recent: [...new Set([...a.recent, ...b.recent])].slice(0, 6), cmp: a.cmp.length ? a.cmp : b.cmp, coupon: a.coupon || b.coupon, addons: [...new Set([...a.addons, ...b.addons])] });
    run('update events set user_id=? where user_id=?', userId, guestId);
    run('delete from users where id=? and role=?', guestId, 'guest');
  }
  const ratings = () => Object.fromEntries(all('select product_id, avg(rating) a, count(*) c from reviews group by product_id').map(r => [r.product_id, { avg: +r.a.toFixed(1), count: r.c }]));
  const hasBought = (userId, productId) => all('select items from orders where user_id=?', userId).some(o => JSON.parse(o.items).some(l => l.id === productId));
  const publicUser = u => ({ id: u.id, email: u.email, role: u.role, guest: u.role === 'guest' });
  const auditLog = (u, tool, args) => run('insert into audit(ts,user_id,tool,args,result,ok) values(?,?,?,?,?,1)', Date.now(), u.id, tool, JSON.stringify(args).slice(0, 500), '{}');
  /** Stock check, stock decrement and order record succeed or fail together. `cart` is [{id, qty}]. */
  function sell(userId, cart, name, src, clearCart) {
    const online = src === 'Online', st = online ? getState(userId) : null;
    db.exec('begin');
    try {
      const lines = cart.map(it => {
        const pr = one('select * from products where id=?', it.id);
        if (!pr) fail(404, 'unknown product ' + it.id);
        if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 99) fail(400, 'bad quantity');
        if (pr.stock < it.qty) fail(409, `${pr.name}: only ${pr.stock} left in stock`);
        return { id: pr.id, name: pr.name, qty: it.qty, price: pr.price };
      });
      for (const l of lines) run('update products set stock=stock-? where id=?', l.qty, l.id);
      const pricing = priceOrder(lines, { coupon: st?.coupon, addons: st?.addons, online }), total = pricing.total;
      const id = Number(run('insert into orders(user_id,ts,name,total,items,src,meta) values(?,?,?,?,?,?,?)', userId, Date.now(), name, total, JSON.stringify(lines), src, JSON.stringify(pricing)).lastInsertRowid);
      if (clearCart) run('delete from carts where user_id=?', userId);
      if (online) putState(userId, { ...st, coupon: '', addons: [] }); // a coupon and add-ons belong to one order
      for (const l of lines) run('insert into events(user_id,type,product_id,ts) values(?,?,?,?)', userId, 'order', l.id, Date.now());
      db.exec('commit');
      return { id, total, items: lines, pricing };
    } catch (e) { db.exec('rollback'); throw e; }
  }

  // ---- HTTP plumbing ----
  const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors " + (E.FRAME_ANCESTORS || "'none'") + "; base-uri 'self'; form-action 'self'";
  // FRAME_ANCESTORS lets a host that shows the site in a frame (for example Hugging Face Spaces) embed it; by default nothing may.
  const baseHeaders = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', ...(E.FRAME_ANCESTORS ? {} : { 'x-frame-options': 'DENY' }), 'content-security-policy': CSP };
  const allowedOrigin = opts.allowedOrigin ?? E.ALLOWED_ORIGIN;
  const send = (req, res, code, obj) => {
    const h = { ...baseHeaders, 'content-type': 'application/json', 'cache-control': 'no-store' };
    const origin = req.headers.origin;
    if (allowedOrigin && origin === allowedOrigin) { h['access-control-allow-origin'] = allowedOrigin; h.vary = 'Origin'; h['access-control-allow-headers'] = 'authorization,content-type'; h['access-control-allow-methods'] = 'GET,POST,PUT,DELETE,OPTIONS'; }
    res.writeHead(code, h); res.end(code === 204 ? '' : JSON.stringify(obj));
  };
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.svg': 'image/svg+xml' };
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname); if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    const ext = path.extname(file).toLowerCase();
    if (!file.startsWith(PUBLIC + path.sep) || !MIME[ext] || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const h = { ...baseHeaders, 'content-type': MIME[ext], 'cache-control': rel.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache' };
    res.writeHead(200, h); res.end(req.method === 'HEAD' ? '' : fs.readFileSync(file));
    return true;
  }
  async function readBody(req) {
    let s = ''; for await (const c of req) { s += c; if (s.length > 64e3) fail(413, 'request too large'); }
    if (!s) return {};
    try { const j = JSON.parse(s); if (typeof j !== 'object' || j === null || Array.isArray(j)) fail(400, 'JSON object expected'); return j; } catch (e) { if (e instanceof HttpError) throw e; fail(400, 'invalid JSON'); }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(req, res, 204, {});
      const url = new URL(req.url, 'http://x'), p = url.pathname, M = req.method;
      if ((M === 'GET' || M === 'HEAD') && !p.startsWith('/api/') && serveStatic(req, res, p)) return;
      if (!p.startsWith('/api/')) return send(req, res, 404, { error: 'not found' });
      const body = M === 'POST' || M === 'PUT' ? await readBody(req) : {};
      // Behind a trusted reverse proxy (TRUST_PROXY=1) the visitor's address is the first X-Forwarded-For entry; otherwise it is the socket's.
      const ip = (E.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
      let u = userFrom(req);
      const need = lv => { if (!u) fail(401, 'sign in required'); if (lv && u.role !== 'admin') fail(403, 'admin only'); };
      const aiUser = () => ({ ...u, profile: u.role === 'admin' ? u.profile : 'customer' });
      let m;

      if (p === '/api/health') return send(req, res, 200, { ok: true });
      if (p === '/api/status') return send(req, res, 200, { mode: KEY ? 'real' : 'demo', model: KEY ? MODEL : null, ai_enabled: one("select v from settings where k='ai_enabled'").v === '1' });
      if (p === '/api/admin/ai' && M === 'GET') { need(1); return send(req, res, 200, { provider: PROVIDER || null, model: KEY ? MODEL : null, ...aiUsage(db, AI_CFG), userDaily: AI_CFG.userDaily, ai_enabled: one("select v from settings where k='ai_enabled'").v === '1' }); }
      if (p === '/api/admin/panel.js' && M === 'GET') { // manager logic is delivered to admins only
        need(1); const h = { ...baseHeaders, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' };
        res.writeHead(200, h); return res.end(fs.readFileSync(path.join(ROOT, 'admin', 'panel.js')));
      }
      if (p === '/api/products' && M === 'GET') { const rt = ratings(); return send(req, res, 200, allProducts(db).map(x => ({ ...x, rating: rt[x.id] || null }))); }
      if ((m = p.match(/^\/api\/products\/([\w-]+)$/)) && M === 'GET') {
        const prod = allProducts(db).find(x => x.id === m[1]); if (!prod) fail(404, 'unknown product');
        return send(req, res, 200, { ...prod, rating: ratings()[prod.id] || null, related: related(db, prod.id) });
      }
      // Reviews: anyone can read; only a signed-in account that has actually bought the product can write one (one per product, editable).
      if ((m = p.match(/^\/api\/products\/([\w-]+)\/reviews$/))) {
        if (!productIds().has(m[1])) fail(404, 'unknown product');
        if (M === 'GET') {
          const rows = all('select r.id, r.rating, r.title, r.body, r.ts, r.user_id, u.email from reviews r left join users u on u.id=r.user_id where r.product_id=? order by r.ts desc limit 50', m[1]);
          const dist = [0, 0, 0, 0, 0]; all('select rating, count(*) c from reviews where product_id=? group by rating', m[1]).forEach(r => { dist[r.rating - 1] = r.c; });
          const count = dist.reduce((a, b) => a + b, 0);
          const name = e => { const s = String(e || '').split('@')[0].replace(/[^a-z0-9]+/gi, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1, 12) : 'Customer'; };
          let mine = null, can = false, why = 'Sign in to review products you have bought.';
          if (u && u.role !== 'guest') { mine = rows.find(r => r.user_id === u.id) || null; can = hasBought(u.id, m[1]); why = can ? '' : 'Only customers who bought this product can review it.'; }
          return send(req, res, 200, { summary: { count, avg: count ? +(dist.reduce((t, n, i) => t + n * (i + 1), 0) / count).toFixed(1) : 0, dist },
            reviews: rows.map(r => ({ id: r.id, rating: r.rating, title: r.title, body: r.body, ts: r.ts, name: name(r.email), mine: !!u && r.user_id === u.id })), canReview: can, reason: why, mine: mine && { rating: mine.rating, title: mine.title, body: mine.body } });
        }
        if (M === 'POST') {
          need(); if (u.role === 'guest') fail(403, 'Create an account to write a review');
          limit('rev:' + u.id, 10, 36e5, 'too many reviews, try again later');
          if (!hasBought(u.id, m[1])) fail(403, 'Only customers who bought this product can review it');
          const rating = Number(body.rating), title = String(body.title || '').trim().slice(0, 80), text = String(body.body || '').trim();
          if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'rating must be 1 to 5');
          if (text.length < 10 || text.length > 1000) fail(400, 'review must be 10 to 1000 characters');
          run('insert into reviews(product_id,user_id,rating,title,body,ts) values(?,?,?,?,?,?) on conflict(product_id,user_id) do update set rating=excluded.rating, title=excluded.title, body=excluded.body, ts=excluded.ts', m[1], u.id, rating, title, text, Date.now());
          return send(req, res, 201, { ok: true, rating: ratings()[m[1]] });
        }
      }

      // Sessions: a visitor gets an anonymous session so their cart and history survive between visits.
      if (p === '/api/session') {
        if (M === 'POST') {
          if (!u) { limit('guest:' + ip, 40, 36e5, 'too many new sessions from this address'); const id = mkUser(null, null, 'guest'); u = one('select * from users where id=?', id); return send(req, res, 201, { token: newSession(id), user: publicUser(u), state: fullState(id) }); }
          return send(req, res, 200, { user: publicUser(u), state: fullState(u.id) });
        }
        need(); return send(req, res, 200, { user: publicUser(u), state: fullState(u.id) });
      }
      if (p === '/api/register' || p === '/api/login') {
        if (M !== 'POST') fail(405, 'POST only');
        const email = normEmail(body.email), password = body.password;
        // Sign-in accepts any existing password length (the demo admin may be short); new accounts need 8 or more characters.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120 || typeof password !== 'string' || !password.length || password.length > 200) fail(400, 'valid email and password required');
        if (p === '/api/register' && password.length < 8) fail(400, 'password must have 8 or more characters');
        const guest = u && u.role === 'guest' ? u : null;
        if (p === '/api/register') {
          limit('reg:' + ip, 15, 36e5, 'too many registrations from this address');
          if (one('select 1 x from users where email=?', email)) fail(409, 'already registered');
          let id;
          if (guest) { // upgrade the anonymous session in place: cart and history carry over
            const salt = crypto.randomBytes(16).toString('hex');
            run('update users set email=?, hash=?, salt=?, role=? where id=?', email, hashPw(password, salt), salt, 'customer', guest.id); id = guest.id;
          } else id = mkUser(email, password);
          const r = one('select * from users where id=?', id);
          return send(req, res, 201, { token: newSession(id), user: publicUser(r), role: r.role, profile: r.profile, state: fullState(id) });
        }
        limit('login:' + ip + ':' + email, 8, 9e5, 'too many sign-in attempts, try again in a few minutes');
        limit('loginip:' + ip, 60, 9e5, 'too many sign-in attempts, try again in a few minutes');
        const r = one('select * from users where email=?', email);
        if (!r || !r.hash || !checkPw(password, r.salt, r.hash)) fail(401, 'wrong email or password');
        if (guest) mergeGuest(guest.id, r.id);
        buckets.delete('login:' + ip + ':' + email);
        return send(req, res, 200, { token: newSession(r.id), user: publicUser(r), role: r.role, profile: r.profile, state: fullState(r.id) });
      }
      if (p === '/api/logout' && M === 'POST') { const tk = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); if (tk) run('delete from sessions where token_hash=?', tokenHash(tk)); return send(req, res, 200, { ok: true }); }

      if (p === '/api/state') {
        need();
        if (M === 'GET') return send(req, res, 200, fullState(u.id));
        if (M === 'PUT') {
          limit('state:' + u.id, 120, 6e4);
          if (body.cart !== undefined) { if (!Array.isArray(body.cart)) fail(400, 'cart must be a list'); setCart(db, u.id, body.cart); }
          const patch = cleanState(body, productIds());
          if (Object.keys(patch).length) putState(u.id, { ...getState(u.id), ...patch });
          run('update users set last_seen=? where id=?', Date.now(), u.id);
          return send(req, res, 200, fullState(u.id));
        }
      }
      if (p === '/api/events' && M === 'POST') {
        need(); limit('ev:' + u.id, 120, 6e4);
        const type = body.type;
        if (!['view', 'search', 'wish', 'cart', 'compare', 'order'].includes(type)) fail(400, 'unknown event type');
        const pid = typeof body.id === 'string' && productIds().has(body.id) ? body.id : null;
        const q = typeof body.q === 'string' ? body.q.trim().slice(0, 80) : null;
        if (!pid && !q) fail(400, 'id or q required');
        // The same action twice within two seconds (a double click) counts once, so it cannot inflate the recommendations.
        if (one("select 1 x from events where user_id=? and type=? and ifnull(product_id,'')=ifnull(?,'') and ifnull(q,'')=ifnull(?,'') and ts>?", u.id, type, pid, q || null, Date.now() - 2000)) return send(req, res, 200, { ok: true, duplicate: true });
        run('insert into events(user_id,type,product_id,q,ts) values(?,?,?,?,?)', u.id, type, pid, q || null, Date.now());
        run('delete from events where user_id=? and id not in (select id from events where user_id=? order by id desc limit 500)', u.id, u.id);
        return send(req, res, 201, { ok: true });
      }
      if (p === '/api/checkout' && M === 'POST') {
        need(); limit('co:' + u.id, 10, 6e4);
        const cart = getCart(db, u.id);
        if (!cart.length) fail(400, 'cart is empty');
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
        const order = sell(u.id, cart, name, 'Online', true);
        return send(req, res, 201, { order, stock: Object.fromEntries(all('select id, stock from products').map(r => [r.id, r.stock])), state: fullState(u.id) });
      }
      if (p === '/api/orders' && M === 'GET') { need(); return send(req, res, 200, all('select id, ts, name, total, items, status, src from orders where user_id=? order by id desc limit 50', u.id).map(o => ({ ...o, items: JSON.parse(o.items) }))); }
      // Repairs: anyone with a session can book; tracking needs the booking session or the last 4 digits of the phone number.
      if (p === '/api/repairs' && M === 'POST') {
        need(); limit('repip:' + ip, 60, 36e5, 'too many repair requests from this address');
        const g = k => String(body[k] ?? '').trim();
        if (g('name').length < 2 || g('name').length > 80) fail(400, 'Enter your name.');
        if (!/^[6-9]\d{9}$/.test(g('phone'))) fail(400, 'Enter a valid 10-digit mobile number.');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(g('email')) || g('email').length > 120) fail(400, 'Enter a valid email address.');
        if (!g('brand') || !g('model') || g('brand').length > 60 || g('model').length > 80) fail(400, 'Enter the brand and model.');
        if (g('prob').length < 10 || g('prob').length > 600) fail(400, 'Describe the problem in 10 to 600 characters.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(g('pref')) || g('pref') < new Date().toISOString().slice(0, 10)) fail(400, 'Choose a service date from today onwards.');
        // The same booking sent twice within two minutes (a double click) returns the first reference instead of creating a second request.
        const same = one('select id from repairs where user_id=? and phone=? and model=? and prob=? and ts>?', u.id, g('phone'), g('model'), g('prob'), Date.now() - 12e4);
        if (same) return send(req, res, 200, { ref: 'RP-' + (1000 + same.id), duplicate: true });
        limit('rep:' + u.id, 5, 36e5, 'too many repair requests, try again later'); // only valid bookings count, so typos never lock anyone out
        const id = Number(run('insert into repairs(user_id,ts,name,phone,email,cat,brand,model,prob,pref,svc,pick) values(?,?,?,?,?,?,?,?,?,?,?,?)', u.id, Date.now(), g('name'), g('phone'), g('email'), g('cat').slice(0, 40), g('brand'), g('model'), g('prob'), g('pref'), g('svc').slice(0, 40), g('pick').slice(0, 60)).lastInsertRowid);
        return send(req, res, 201, { ref: 'RP-' + (1000 + id) });
      }
      if ((m = p.match(/^\/api\/repairs\/RP-(\d+)$/i)) && M === 'GET') {
        limit('trk:' + ip, 30, 6e4, 'too many lookups, slow down');
        const r = one('select * from repairs where id=?', +m[1] - 1000), last4 = String(url.searchParams.get('phone') || '');
        if (!r || !((u && u.id === r.user_id) || (last4.length === 4 && r.phone.endsWith(last4)))) fail(404, 'No request with that ID was found. Check the ID, and the last 4 digits of the phone number you booked with.');
        return send(req, res, 200, { ref: 'RP-' + (1000 + r.id), status: r.status, step: REPAIR_STATUSES.indexOf(r.status) + 1, of: REPAIR_STATUSES.length, device: r.brand + ' ' + r.model, est: r.est, note: r.note });
      }
      if (p === '/api/admin/repairs' && M === 'GET') { need(1); return send(req, res, 200, all('select * from repairs order by id desc limit 300').map(r => ({ ...r, ref: 'RP-' + (1000 + r.id) }))); }
      if ((m = p.match(/^\/api\/admin\/repairs\/RP-(\d+)$/i)) && M === 'PUT') {
        need(1); const r = one('select * from repairs where id=?', +m[1] - 1000); if (!r) fail(404, 'unknown repair');
        const status = body.status === undefined ? r.status : body.status, est = body.est === undefined ? r.est : Number(body.est), note = body.note === undefined ? r.note : String(body.note).slice(0, 300);
        if (!REPAIR_STATUSES.includes(status)) fail(400, 'bad status'); if (!Number.isInteger(est) || est < 0 || est > 1e7) fail(400, 'estimate must be a whole number');
        run('update repairs set status=?, est=?, note=? where id=?', status, est, note, r.id);
        auditLog(u, 'admin_repair_update', { ref: 'RP-' + (1000 + r.id), status, est }); return send(req, res, 200, { ok: true });
      }
      if (p === '/api/recommendations' && M === 'GET') {
        need(); const n = Math.min(Math.max(+url.searchParams.get('limit') || 6, 1), 12);
        return send(req, res, 200, recommend(db, u.id, { limit: n }));
      }

      if (p === '/api/ai/chat' && M === 'POST') {
        need(); limit('chat:' + u.id, 20, 6e4, 'rate limit: 20 messages a minute');
        if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1000) fail(400, 'message required (max 1000 chars)');
        run('insert into events(user_id,type,q,ts) values(?,?,?,?)', u.id, 'search', body.message.trim().slice(0, 80), Date.now()); // what they ask the assistant is an interest signal too
        return send(req, res, 200, await chat(db, aiUser(), body.message.trim(), aiCfg));
      }
      if (p === '/api/approvals' && M === 'GET') { need(); return send(req, res, 200, u.role === 'admin' ? all('select * from approvals order by id desc limit 50') : all('select * from approvals where user_id=? order by id desc limit 50', u.id)); }
      if ((m = p.match(/^\/api\/approvals\/(\d+)\/(confirm|reject)$/)) && M === 'POST') {
        need();
        const a = one('select * from approvals where id=? and status=?', m[1], 'pending');
        if (!a || (a.user_id !== u.id && u.role !== 'admin')) fail(404, 'not found');
        const claim = run("update approvals set status=? where id=? and status='pending'", m[2] === 'reject' ? 'rejected' : 'processing', a.id);
        if (!claim.changes) fail(409, 'approval already handled');
        if (m[2] === 'reject') return send(req, res, 200, { status: 'rejected' });
        const owner = one('select * from users where id=?', a.user_id);
        const x = exec(db, a.tool, JSON.parse(a.args), { ...owner, profile: owner.role === 'admin' ? owner.profile : 'customer' }, true);
        run("update approvals set status=? where id=? and status='processing'", x.error ? 'failed' : 'approved', a.id);
        return send(req, res, 200, { ...x, state: fullState(a.user_id) });
      }
      if (p === '/api/memory' && M === 'GET') { need(); return send(req, res, 200, all('select k,v from memory where user_id=?', u.id)); }
      if ((m = p.match(/^\/api\/memory\/(.+)$/)) && M === 'DELETE') { need(); run('delete from memory where user_id=? and k=?', u.id, decodeURIComponent(m[1])); return send(req, res, 200, { deleted: true }); }
      if (p === '/api/profile' && M === 'POST') {
        need(); if (u.role !== 'admin') fail(403, 'only an admin can change an AI profile');
        if (!LEVEL[body.profile]) fail(400, 'profile not allowed');
        run('update users set profile=? where id=?', body.profile, u.id); return send(req, res, 200, { profile: body.profile });
      }
      if (p === '/api/admin/tools' && M === 'GET') { need(1); return send(req, res, 200, Object.entries(TOOLS).map(([n, t]) => ({ name: n, level: t.level, approval: !!t.approval, memory: !!t.memory, enabled: one('select enabled from tools where name=?', n)?.enabled !== 0 }))); }
      if ((m = p.match(/^\/api\/admin\/tools\/(\w+)$/)) && M === 'POST') {
        need(1); if (!TOOLS[m[1]]) fail(404, 'unknown tool');
        run('insert or replace into tools values(?,?)', m[1], body.enabled ? 1 : 0);
        run('insert into audit(ts,user_id,tool,args,result,ok) values(?,?,?,?,?,1)', Date.now(), u.id, 'admin_tool_toggle', JSON.stringify({ tool: m[1], enabled: !!body.enabled }), '{}');
        return send(req, res, 200, { ok: true });
      }
      if (p === '/api/admin/kill' && M === 'POST') {
        need(1); run("insert or replace into settings values('ai_enabled',?)", body.enabled ? '1' : '0');
        run('insert into audit(ts,user_id,tool,args,result,ok) values(?,?,?,?,?,1)', Date.now(), u.id, 'admin_kill_switch', JSON.stringify({ enabled: !!body.enabled }), '{}');
        return send(req, res, 200, { ai_enabled: !!body.enabled });
      }
      if (p === '/api/admin/audit' && M === 'GET') { need(1); return send(req, res, 200, all('select * from audit order by id desc limit 100')); }
      if (p === '/api/admin/inventory' && M === 'GET') { need(1); return send(req, res, 200, allProducts(db)); }

      // ---- store manager (admin only: every route below calls need(1)) ----
      if (p === '/api/admin/overview' && M === 'GET') {
        need(1);
        const prods = new Map(allProducts(db).map(x => [x.id, x]));
        const orders = all('select * from orders').map(o => ({ ...o, items: JSON.parse(o.items) }));
        const byCat = {}, units = {};
        for (const o of orders) for (const l of o.items) { const c = prods.get(l.id)?.cat || 'Other'; byCat[c] = (byCat[c] || 0) + l.price * l.qty; units[l.id] = (units[l.id] || 0) + l.qty; }
        const top = Object.entries(units).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ id, name: prods.get(id)?.name || id, units: n }));
        const list = [...prods.values()];
        return send(req, res, 200, {
          revenue: orders.reduce((t, o) => t + o.total, 0), orders: orders.length, pending: orders.filter(o => o.status === 'Pending').length,
          customers: one("select count(*) c from users where role='customer'").c, stockValue: list.reduce((t, x) => t + x.price * x.stock, 0),
          products: list.length, byCategory: byCat, top, low: list.filter(x => x.stock <= x.reorder).map(x => ({ id: x.id, name: x.name, stock: x.stock, reorder: x.reorder })),
          ai: { provider: PROVIDER || null, model: KEY ? MODEL : null, ...aiUsage(db, AI_CFG) }
        });
      }
      if (p === '/api/admin/orders' && M === 'GET') {
        need(1);
        return send(req, res, 200, all('select o.id, o.ts, o.name, o.total, o.items, o.src, o.status, u.email from orders o left join users u on u.id=o.user_id order by o.id desc limit 300').map(o => ({ ...o, items: JSON.parse(o.items) })));
      }
      if ((m = p.match(/^\/api\/admin\/orders\/(\d+)\/status$/)) && M === 'POST') {
        need(1); if (!['Pending', 'Packed', 'Shipped', 'Completed'].includes(body.status)) fail(400, 'bad status');
        if (!run('update orders set status=? where id=?', body.status, +m[1]).changes) fail(404, 'unknown order');
        auditLog(u, 'admin_order_status', { order: +m[1], status: body.status }); return send(req, res, 200, { ok: true });
      }
      if (p === '/api/admin/counter-sale' && M === 'POST') {
        need(1); limit('sale:' + u.id, 60, 6e4);
        if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) fail(400, 'items required');
        const lines = body.items.map(i => ({ id: String(i?.id || ''), qty: Number(i?.qty) }));
        const order = sell(u.id, lines, typeof body.name === 'string' ? body.name.trim().slice(0, 80) : 'Walk-in', 'Counter', false);
        run("update orders set status='Completed' where id=?", order.id);
        auditLog(u, 'admin_counter_sale', { order: order.id, total: order.total });
        return send(req, res, 201, { order, stock: Object.fromEntries(all('select id, stock from products').map(r => [r.id, r.stock])) });
      }
      if (p === '/api/admin/products' && M === 'POST') {
        need(1);
        const name = typeof body.name === 'string' ? body.name.trim() : '', cat = body.cat, price = Number(body.price), stock = Number(body.stock ?? 0), re = Number(body.reorder ?? 5);
        if (name.length < 2 || name.length > 120) fail(400, 'name must be 2 to 120 characters');
        if (!all('select distinct cat from products').some(r => r.cat === cat)) fail(400, 'unknown category');
        if (one('select 1 x from products where lower(name)=lower(?)', name)) fail(409, 'A product with this name already exists');
        if (![price, stock, re].every(Number.isInteger) || price < 0 || price > 1e7 || stock < 0 || stock > 1e5 || re < 0 || re > 1e4) fail(400, 'price, stock and reorder level must be whole numbers in range');
        const n = Math.max(900, ...all("select id from products where id like 'VB-9%'").map(r => parseInt(r.id.slice(3), 10) || 0)) + 1, id = 'VB-' + n;
        run("insert into products(id,name,brand,cat,price,stock,reorder,summary,description,highlights,specs,tags,image,image_credit,source,locked) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'admin',1)",
          id, name, String(body.brand || '').slice(0, 60), cat, price, stock, re, String(body.summary || '').slice(0, 200), String(body.description || '').slice(0, 1000), '[]', '{}', '[]', '', 'null');
        auditLog(u, 'admin_product_add', { id, name }); return send(req, res, 201, { id });
      }
      if ((m = p.match(/^\/api\/admin\/products\/([\w-]+)$/)) && (M === 'PUT' || M === 'DELETE')) {
        need(1); const row = one('select * from products where id=?', m[1]); if (!row) fail(404, 'unknown product');
        if (M === 'DELETE') {
          if (row.source !== 'admin') fail(409, 'catalogue products cannot be deleted here: set the stock to 0, or remove the product from data/products.json');
          run('delete from carts where product_id=?', row.id); run('delete from products where id=?', row.id);
          auditLog(u, 'admin_product_delete', { id: row.id }); return send(req, res, 200, { deleted: true });
        }
        const set = [], args = [];
        for (const [k, col, max] of [['price', 'price', 1e7], ['stock', 'stock', 1e5], ['reorder', 'reorder', 1e4]]) {
          if (body[k] === undefined) continue;
          const v = Number(body[k]); if (!Number.isInteger(v) || v < 0 || v > max) fail(400, k + ' must be a whole number from 0 to ' + max);
          set.push(col + '=?'); args.push(v);
        }
        if (!set.length) fail(400, 'nothing to change');
        if (body.price !== undefined || body.reorder !== undefined) set.push('locked=1');
        run(`update products set ${set.join(',')} where id=?`, ...args, row.id);
        auditLog(u, 'admin_product_edit', { id: row.id, ...Object.fromEntries(['price', 'stock', 'reorder'].filter(k => body[k] !== undefined).map(k => [k, body[k]])) });
        return send(req, res, 200, allProducts(db).find(x => x.id === row.id));
      }
      if (p === '/api/admin/reviews' && M === 'GET') { need(1); return send(req, res, 200, all('select r.id, r.product_id, p.name product, r.rating, r.title, r.body, r.ts, u.email from reviews r left join products p on p.id=r.product_id left join users u on u.id=r.user_id order by r.ts desc limit 100')); }
      if ((m = p.match(/^\/api\/admin\/reviews\/(\d+)$/)) && M === 'DELETE') { need(1); if (!run('delete from reviews where id=?', +m[1]).changes) fail(404, 'unknown review'); auditLog(u, 'admin_review_delete', { id: +m[1] }); return send(req, res, 200, { deleted: true }); }
      if (p === '/api/admin/files' && M === 'GET') { // the source-code viewer is for the owner only
        need(1); const f = path.join(ROOT, 'data', 'project-files.json');
        return send(req, res, 200, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
      }
      send(req, res, 404, { error: 'not found' });
    } catch (e) {
      const code = e.c || 500;
      if (code === 500) console.error(e);
      send(req, res, code, { error: code === 500 ? 'internal error' : e.message });
    }
  });
  return { server, db };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createApp();
  const port = +E.PORT || 3000;
  server.listen(port, E.HOST || '127.0.0.1', () => console.log(`VoltBay on http://localhost:${port} (${KEY ? `AI: ${PROVIDER} ${MODEL}, max ${AI_CFG.dailyLimit} requests/day` : 'AI demo mode, no API key set in .env'}; admin: ${E.ADMIN_EMAIL ? E.ADMIN_EMAIL : 'not configured'})`));
}
