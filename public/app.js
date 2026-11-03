/* VoltBay storefront <-> server glue.
   - keeps the shopper's session (cart, saved items, recently viewed) on the server so it survives between visits
   - loads the real catalogue (details, specs, photos) and live stock
   - shows personalised recommendations and talks to the VoltAI assistant
   If the server cannot be reached, the page keeps working exactly as the offline demo it used to be. */
(function () {
  'use strict';
  var TOKEN_KEY = 'voltbay_token';
  var tok = '', user = null, online = false, ready = false, RECS = null;
  var lastWish = {}, lastCmp = [];
  var timers = {};

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; }
  }
  function api(method, path, body) {
    var opt = { method: method, headers: { 'content-type': 'application/json' } };
    if (tok) opt.headers.authorization = 'Bearer ' + tok;
    if (body !== undefined) opt.body = JSON.stringify(body);
    var used = tok; // the token this request was sent with
    return fetch(path, opt).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; j._stale = used !== tok; return j; }); });
  }
  window.VBApi = api; // used by the admin script, which the server only sends to a signed-in admin
  function later(name, ms, fn) { clearTimeout(timers[name]); timers[name] = setTimeout(fn, ms); }
  function cartList() { return Object.keys(S.cart).map(function (id) { return { id: id, qty: S.cart[id] }; }); }
  function track(type, id, q) { if (online && ready) api('POST', '/api/events', id ? { type: type, id: id } : { type: type, q: q }).then(function () { if (type !== 'search') later('recs', 800, loadRecs); }); }

  /* ---------- catalogue ---------- */
  function loadCatalogue() {
    return fetch('/api/products').then(function (r) { return r.json(); }).then(function (list) {
      var byId = {}; S.products.forEach(function (p) { byId[p.id] = p; });
      S.products = list.map(function (sp) {
        var p = byId[sp.id] || { sold: {} };
        p.id = sp.id; p.name = sp.name; p.cat = sp.cat; p.price = sp.price; p.stock = sp.stock; p.re = sp.reorder; p.ic = sp.id.toLowerCase();
        p.brand = sp.brand; p.summary = sp.summary; p.description = sp.description; p.highlights = sp.highlights; p.specs = sp.specs; p.tags = sp.tags;
        p.img = sp.image; p.credit = sp.imageCredit; p.featured = sp.featured; p.rating = sp.rating;
        SPEC[p.ic] = sp.summary;
        return p;
      });
    });
  }
  function applyStock(map) { S.products.forEach(function (p) { if (map && map[p.id] !== undefined) p.stock = map[p.id]; }); }

  var _pl = pl;
  pl = function (p) { var h = _pl(p); return p && p.img ? h.replace('<div class="pl"><span>', '<div class="pl"><span style="display:flex;align-items:center;gap:8px"><img class="plimg" src="' + esc(p.img) + '" alt=""><span>').replace('</small></span><span>', '</small></span></span><span>') : h; };
  var _pic = pic;
  pic = function (p) { return p && p.img ? '<img src="' + esc(p.img) + '" alt="' + esc(p.name) + '" loading="lazy" decoding="async">' : _pic(p); };

  /* ---------- session state ---------- */
  function adopt(state) {
    S.cart = {};
    (state.cart || []).forEach(function (i) { if (P(i.id)) S.cart[i.id] = i.qty; });
    S.wish = state.wish || {}; S.recent = (state.recent || []).filter(P); S.cmp = (state.cmp || []).filter(P); if (state.coupon) S.coupon = state.coupon;
    if (Array.isArray(state.addons)) { S.addons = {}; state.addons.forEach(function (k) { S.addons[k] = 1; }); }
    lastWish = Object.assign({}, S.wish); lastCmp = S.cmp.slice();
    _save(); _renderCart(); render();
  }
  function pushState() {
    if (!online || !ready) return;
    var added = Object.keys(S.wish).filter(function (id) { return !lastWish[id]; }), cmpNew = S.cmp.filter(function (id) { return lastCmp.indexOf(id) < 0; });
    lastWish = Object.assign({}, S.wish); lastCmp = S.cmp.slice();
    added.forEach(function (id) { track('wish', id); }); cmpNew.forEach(function (id) { track('compare', id); });
    var sent = JSON.stringify(S.cart);
    api('PUT', '/api/state', { cart: cartList(), wish: S.wish, recent: S.recent, cmp: S.cmp, coupon: S.coupon, addons: Object.keys(S.addons) }).then(function (st) {
      // A 401 for a token that has since been replaced (for example by signing in) must not start a new guest session over the new one.
      if (st._status !== 200) { if (st._status === 401 && !st._stale) bootSession(true); return; }
      if (JSON.stringify(S.cart) !== sent) return; // the cart changed again while this was in flight; the next save reconciles
      var server = {}; st.cart.forEach(function (i) { server[i.id] = i.qty; });
      if (JSON.stringify(server) !== JSON.stringify(S.cart)) { S.cart = server; _renderCart(); toast('Your cart was adjusted to what is in stock'); }
      later('recs', 600, loadRecs);
    }).catch(function () {});
  }
  var _save = save; save = function () { _save(); later('state', 500, pushState); };
  var _renderCart = renderCart; renderCart = function () { _renderCart(); if (ready) later('state', 400, pushState); };
  var _addCart = addCart; addCart = function (id) { var had = S.cart[id] || 0; _addCart(id); if (S.cart[id] > had) track('cart', id); };
  var _openV = openV;
  openV = function (id) { _openV(id); track('view', id); enrich(id); };

  /* ---------- recommendations ---------- */
  function loadRecs() {
    if (!online || !ready) return;
    api('GET', '/api/recommendations?limit=4').then(function (r) { if (r.items) { RECS = r; paintRecs(); } }).catch(function () {});
  }
  function paintRecs() {
    var el = $('recent'); if (!el || !RECS) return;
    var rc = S.recent.map(P).filter(Boolean).slice(0, 4);
    var cards = RECS.items.map(function (r) {
      var p = P(r.id); if (!p) return '';
      return mini(p).replace('<button class="btn" data-add', '<small class="why">' + esc(r.reason) + '</small><button class="btn" data-add');
    }).join('');
    el.innerHTML = (rc.length ? '<h2>Recently viewed</h2><div class="hrow">' + rc.map(function (p) { return mini(p); }).join('') + '</div>' : '') +
      '<h2 style="margin-top:22px">' + (RECS.personalised ? 'Recommended for you' : 'Popular picks to start with') + '</h2><div class="hrow">' + cards + '</div>';
  }
  var _renderHome = renderHome; renderHome = function () { _renderHome(); paintRecs(); };

  /* ---------- product details in the popup ---------- */
  function enrich(id) {
    var p = P(id), box = $('mbox'); if (!p || !p.specs || !box) return;
    var col = box.children[1]; if (!col) return;
    var rows = Object.keys(p.specs).map(function (k) { return '<tr><th>' + esc(k) + '</th><td>' + esc(p.specs[k]) + '</td></tr>'; }).join('');
    var hl = (p.highlights || []).map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('');
    var cr = p.credit ? '<div class="credit">Photo: ' + esc(p.credit.author) + ', <a href="' + esc(p.credit.page) + '" target="_blank" rel="noopener noreferrer">' + esc(p.credit.license) + '</a>, via Wikimedia Commons. Prices are indicative; specifications are the manufacturer’s published figures.</div>' : '';
    var d = document.createElement('div'); d.innerHTML = (hl ? '<ul class="hl">' + hl + '</ul>' : '') + '<table class="spec">' + rows + '</table><div id="rel"></div><div id="revs"></div>' + cr;
    col.insertBefore(d, col.lastElementChild);
    if (online) fetch('/api/products/' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (j) {
      var el = document.getElementById('rel'); if (!el || !j.related) return;
      var items = j.related.map(function (r) { var q = P(r.id); return q ? '<button class="chip" data-v="' + q.id + '" title="' + esc(r.reason) + '">' + esc(q.name) + '</button>' : ''; }).join(' ');
      if (items) el.innerHTML = '<p class="sku" style="margin:8px 0 4px">You may also like</p>' + items;
    }).catch(function () {});
    if (online) loadReviews(id);
  }

  /* ---------- reviews (verified buyers only; the server enforces it) ---------- */
  function starStr(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }
  function loadReviews(id) {
    api('GET', '/api/products/' + encodeURIComponent(id) + '/reviews').then(function (j) {
      var el = document.getElementById('revs'); if (!el || !j.summary) return;
      var s = j.summary, html = '<h3 style="font-size:16px;margin:14px 0 6px">Customer reviews</h3>';
      if (!s.count) html += '<p class="sku">No reviews yet.</p>';
      else {
        html += '<p style="margin:0 0 6px"><span class="stars">' + starStr(Math.round(s.avg)) + '</span> <b>' + s.avg + '</b> out of 5, ' + s.count + ' review' + (s.count === 1 ? '' : 's') + '</p>';
        for (var k = 5; k >= 1; k--) html += '<div class="revbar"><span>' + k + '★</span><span><i style="width:' + Math.round(s.dist[k - 1] / s.count * 100) + '%"></i></span><span>' + s.dist[k - 1] + '</span></div>';
        html += j.reviews.map(function (r) { return '<div class="rev"><h4>' + starStr(r.rating) + ' ' + esc(r.title || '') + '</h4><small>' + esc(r.name) + ' · Verified buyer · ' + new Date(r.ts).toLocaleDateString('en-IN') + '</small><p style="margin:4px 0 0">' + esc(r.body) + '</p></div>'; }).join('');
      }
      if (j.canReview) {
        var m = j.mine || {};
        html += '<div class="revform"><b>' + (j.mine ? 'Edit your review' : 'Write a review') + '</b><select id="rvr" aria-label="Rating">' + [5, 4, 3, 2, 1].map(function (n) { return '<option value="' + n + '"' + (n === (m.rating || 5) ? ' selected' : '') + '>' + starStr(n) + ' (' + n + ')</option>'; }).join('') + '</select>' +
          '<input id="rvt" maxlength="80" placeholder="Headline (optional)" value="' + esc(m.title || '') + '"><textarea id="rvb" rows="3" maxlength="1000" placeholder="What did you like or dislike? (10 or more characters)">' + esc(m.body || '') + '</textarea><div class="err" id="rve" role="alert"></div><button class="btn" id="rvs">Post review</button></div>';
      } else html += '<p class="sku" style="margin-top:8px">' + esc(j.reason || '') + '</p>';
      el.innerHTML = html;
      var b = document.getElementById('rvs');
      if (b) b.onclick = function () {
        b.disabled = true;
        api('POST', '/api/products/' + encodeURIComponent(id) + '/reviews', { rating: +document.getElementById('rvr').value, title: document.getElementById('rvt').value, body: document.getElementById('rvb').value }).then(function (r) {
          if (r.error) { document.getElementById('rve').textContent = r.error; b.disabled = false; return; }
          var p = P(id); if (p) p.rating = r.rating; toast('Thanks for your review'); loadReviews(id); render();
        });
      };
    }).catch(function () {});
  }

  /* ---------- repairs: stored on the server so the store sees every booking ---------- */
  var repForm = $('repform'), _repSubmit = repForm.onsubmit, _trk = $('trkbtn').onclick, repBusy = false;
  repForm.onsubmit = function (e) {
    if (!online || !ready) return _repSubmit.call(this, e); // offline demo behaviour
    e.preventDefault();
    var g = function (i) { return $(i).value.trim(); }, m = '';
    if (g('rfn').length < 2) m = 'Enter your name.'; else if (!/^[6-9]\d{9}$/.test(g('rfp'))) m = 'Enter a valid 10-digit mobile number.';
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(g('rfe'))) m = 'Enter a valid email address.'; else if (!g('rfb') || !g('rfm')) m = 'Enter the brand and model.';
    else if (g('rfd').length < 10) m = 'Describe the problem in at least 10 characters.'; else if (!g('rft') || g('rft') < new Date().toISOString().slice(0, 10)) m = 'Choose a service date from today onwards.';
    $('reperr').textContent = m; if (m) return;
    var body = { name: g('rfn'), phone: g('rfp'), email: g('rfe'), cat: $('rfc').value, brand: g('rfb'), model: g('rfm'), prob: g('rfd'), pref: g('rft'), svc: $('rfs').value, pick: $('rfk').value };
    if (repBusy) return; repBusy = true; // a double click must not book the repair twice
    api('POST', '/api/repairs', body).then(function (r) {
      repBusy = false;
      if (!r.ref) { $('reperr').textContent = r.error || 'Could not book the repair. Please try again.'; return; }
      var pref = body.pref, pick = body.pick; repForm.reset(); $('repok').hidden = false;
      $('repok').innerHTML = '<b>Booking received. Your repair ID is ' + esc(r.ref) + '.</b><br>Preferred date ' + esc(pref) + ', ' + esc(pick) + '. Keep this ID: you can check the status below with it (and the last 4 digits of your phone from another device). This is a demo store, not a real service appointment.';
      $('trkid').value = r.ref; toast('Repair ' + r.ref + ' booked');
    }).catch(function () { repBusy = false; $('reperr').textContent = 'The store could not be reached. Please try again.'; });
  };
  $('trkbtn').onclick = function () {
    if (!online || !ready) return _trk.call(this);
    var id = $('trkid').value.trim().toUpperCase();
    api('GET', '/api/repairs/' + encodeURIComponent(id) + '?phone=' + encodeURIComponent($('trkph').value.trim())).then(function (r) {
      $('trkres').innerHTML = r.ref ? '<b>' + esc(r.ref) + ': ' + esc(r.status) + '</b> (step ' + r.step + ' of ' + r.of + ')<div class="prog"><i style="width:' + (r.step / r.of * 100) + '%"></i></div>' + esc(r.device) + (r.est ? '<br>Estimate: ' + inr(r.est) : '') + (r.note ? '<br>Notes: ' + esc(r.note) : '') : esc(r.error || 'No request with that ID was found.');
    });
  };

  /* ---------- search tracking ---------- */
  var qEl = $('q');
  if (qEl) qEl.addEventListener('input', function () { var v = qEl.value.trim(); if (v.length >= 3) later('q', 1200, function () { track('search', null, v); }); });

  /* ---------- checkout: the server owns stock ---------- */
  var coBtn = $('checkout'), _co = coBtn.onclick, coBusy = false;
  coBtn.onclick = function () {
    var self = this;
    if (!online || !ready) return _co.call(self);
    if (!Object.keys(S.cart).length) { toast('Cart is empty'); return; }
    if (coBusy) return; coBusy = true; // a double click must not place the order twice
    clearTimeout(timers.state);
    api('PUT', '/api/state', { cart: cartList(), coupon: S.coupon, addons: Object.keys(S.addons) }).then(function () {
      return api('POST', '/api/checkout', { name: $('cname').value.trim() });
    }).then(function (r) {
      if (r._status !== 201) {
        toast(r.error || 'Could not place the order');
        return loadCatalogue().then(function () { return api('GET', '/api/state'); }).then(function (st) { adopt(st); });
      }
      S.seq = r.order.id; // the receipt shows the same order number the store and admin see
      _co.call(self); // records the demo order and shows the receipt
      applyStock(r.stock); _save(); render();
      lastWish = Object.assign({}, S.wish); later('recs', 300, loadRecs);
    }).catch(function () { toast('The store could not be reached. Try again.'); }).then(function () { coBusy = false; });
  };

  /* ---------- VoltAI ---------- */
  var _aiSendLocal = aiSend;
  aiSend = function (q) {
    q = String(q).trim(); if (!q) return;
    if (!online || !ready) return _aiSendLocal(q);
    aiAdd(esc(q), 'u'); $('aiq').value = '';
    var t = document.createElement('div'); t.className = 'm b typing'; t.textContent = 'VoltAI is thinking...'; $('ailog').appendChild(t);
    api('POST', '/api/ai/chat', { message: q }).then(function (r) {
      t.remove();
      if (r._status === 401 && r._stale) { aiAdd('Please ask again.', 'b'); return; }
      if (r._status === 401) { return bootSession(true).then(function () { aiAdd('Your session was refreshed. Please ask again.', 'b'); }); }
      if (r.error) { aiAdd(esc(r.error), 'b'); return; }
      var html = esc(r.reply) + (r.products || []).map(function (p) { var lp = P(p.id); return lp ? pl(lp) : ''; }).join('') +
        (r.pending || []).map(function (a) { return '<div class="pl"><span>' + esc(a.summary) + '</span><span><button class="btn" data-apr="' + a.id + '">Confirm</button> <button class="chip" data-rej="' + a.id + '">Cancel</button></span></div>'; }).join('');
      aiAdd(html, 'b'); later('recs', 500, loadRecs);
    }).catch(function () {
      // Server unreachable: answer with the built-in offline assistant instead of a dead end.
      t.remove(); var log = $('ailog'), last = log.lastChild; if (last && last.className.indexOf('u') > -1) log.removeChild(last);
      online = false; toast('Server not reachable. Using offline mode (cart will not be saved).');
      _aiSendLocal(q);
    });
  };
  $('ailog').addEventListener('click', function (e) {
    var a = e.target.dataset.apr, rj = e.target.dataset.rej, id = a || rj; if (!id) return;
    var row = e.target.closest('.pl'); row.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    api('POST', '/api/approvals/' + id + '/' + (a ? 'confirm' : 'reject')).then(function (r) {
      if (r.error) { aiAdd(esc(r.error), 'b'); return; }
      if (a && r.state) { adopt(r.state); aiAdd('Done. Your cart is updated.', 'b'); } else aiAdd('Okay, I have not changed anything.', 'b');
      later('recs', 400, loadRecs);
    });
  });

  /* ---------- account ---------- */
  var acct = $('acctbtn');
  function isAdmin() { return !!(user && user.role === 'admin'); }
  var adminLoaded = null;
  // The store-manager code is fetched with the admin's token: the server refuses everyone else.
  function loadAdmin() {
    if (!isAdmin()) return Promise.resolve(false);
    if (adminLoaded) return adminLoaded;
    window.VBReload = loadCatalogue;
    adminLoaded = fetch('/api/admin/panel.js', { headers: { authorization: 'Bearer ' + tok } }).then(function (r) { if (!r.ok) throw new Error('admin only'); return r.text(); }).then(function (code) {
      var s = document.createElement('script'); s.textContent = code; document.head.appendChild(s); return true;
    }).catch(function () { adminLoaded = null; return false; });
    return adminLoaded;
  }
  function paintAccount() {
    acct.textContent = user && !user.guest ? user.email.split('@')[0] : 'Sign in'; acct.title = user && !user.guest ? user.email : 'Sign in to keep your cart on every device';
    var adm = document.querySelector('details.adm'); if (adm) adm.hidden = !isAdmin(); // the Admin menu exists only for a signed-in admin
    if (isAdmin()) loadAdmin(); else if (!isAdmin() && /mgr|files/.test(document.body.dataset.mode || '')) mode('shop');
  }
  var _mode = mode;
  mode = function (m) {
    document.body.dataset.mode = m;
    if (m === 'mgr' || m === 'files') {
      if (!isAdmin()) { document.body.dataset.mode = 'shop'; toast('Admin sign-in required'); _mode('shop'); acct.click(); return; }
      _mode(m); loadAdmin().then(function (okk) { if (okk && window.VBAdmin) window.VBAdmin.open(m); });
      return;
    }
    _mode(m);
  };
  function openModal(html) { var mb = $('mbox'); mb.style.gridTemplateColumns = '1fr'; mb.innerHTML = '<div class="acct">' + html + '</div>'; $('modal').classList.add('open'); }
  acct.onclick = function () {
    if (!online) { toast('The store server is not reachable, so accounts are unavailable.'); return; }
    if (user && !user.guest) { accountPanel(); return; }
    var mode = 'login';
    (function draw() {
      openModal('<h2 style="font-size:22px">' + (mode === 'login' ? 'Sign in' : 'Create your account') + '</h2><p class="sku">Your cart and saved items travel with you. What you have in the cart now is kept.</p>' +
        '<label>Email<input id="ae" type="email" autocomplete="email"></label><label>Password (8 or more characters)<input id="ap" type="password" autocomplete="' + (mode === 'login' ? 'current-password' : 'new-password') + '"></label>' +
        '<div class="err" id="aerr" role="alert"></div><p><button class="btn" id="ago">' + (mode === 'login' ? 'Sign in' : 'Create account') + '</button> <button class="chip" id="aswap">' + (mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in') + '</button> <button class="btn alt" id="mclose">Close</button></p>');
      $('aswap').onclick = function () { mode = mode === 'login' ? 'register' : 'login'; draw(); };
      $('ago').onclick = function () {
        $('ago').disabled = true;
        api('POST', mode === 'login' ? '/api/login' : '/api/register', { email: $('ae').value, password: $('ap').value }).then(function (r) {
          if (!r.token) { $('aerr').textContent = r.error || 'Something went wrong'; $('ago').disabled = false; return; }
          tok = r.token; store(TOKEN_KEY, tok); user = r.user; paintAccount(); adopt(r.state); $('modal').classList.remove('open'); toast('Signed in as ' + user.email); loadRecs();
        });
      };
      $('ae').focus();
    })();
  };
  function accountPanel() {
    Promise.all([api('GET', '/api/memory'), api('GET', '/api/orders')]).then(function (res) {
      var mem = res[0], ords = Array.isArray(res[1]) ? res[1] : [], m = Array.isArray(mem) ? mem : [];
      var orders = '<p class="sku" style="margin-top:12px">Your orders:</p>' + (ords.length ? ords.slice(0, 8).map(function (o) { return '<div class="ln"><span><b>#' + o.id + '</b> · ' + new Date(o.ts).toLocaleDateString('en-IN') + '<br><small class="sku">' + esc(o.items.map(function (l) { return l.name + ' ×' + l.qty; }).join(', ').slice(0, 120)) + '</small></span><span><b>' + inr(o.total) + '</b><br><small class="sku">' + esc(o.status) + '</small></span></div>'; }).join('') : '<p class="sku">No orders yet.</p>');
      openModal('<h2 style="font-size:22px">' + esc(user.email) + '</h2><p class="sku">What VoltAI remembers about you (you control it):</p>' +
        (m.length ? m.map(function (x) { return '<div class="ln"><span><b>' + esc(x.k) + '</b>: ' + esc(x.v) + '</span><button class="chip" data-forget="' + esc(x.k) + '">Forget</button></div>'; }).join('') : '<p class="sku">Nothing yet. Tell VoltAI things like "my budget is 20000".</p>') +
        orders + '<p>' + (isAdmin() ? '<button class="btn" id="aadm">Open Manage store</button> ' : '') + '<button class="btn' + (isAdmin() ? ' alt' : '') + '" id="aout">Sign out</button> <button class="btn alt" id="mclose">Close</button></p>');
      if ($('aadm')) $('aadm').onclick = function () { $('modal').classList.remove('open'); mode('mgr'); };
      $('aout').onclick = function () {
        var wasAdmin = isAdmin();
        api('POST', '/api/logout').then(function () {
          store(TOKEN_KEY, null); tok = '';
          if (wasAdmin) { try { localStorage.removeItem('voltbay2'); } catch (e) { } location.reload(); return null; } // drop all manager state from this browser
          S.cart = {}; S.wish = {}; S.recent = []; S.cmp = []; ready = false; $('modal').classList.remove('open'); return bootSession(false);
        }).then(function (x) { if (x !== null) toast('Signed out'); });
      };
      $('mbox').querySelectorAll('[data-forget]').forEach(function (b) { b.onclick = function () { api('DELETE', '/api/memory/' + encodeURIComponent(b.dataset.forget)).then(accountPanel); }; });
    });
  }
  var cr = document.getElementById('credits');
  if (cr) cr.onclick = function (e) {
    e.preventDefault();
    var rows = S.products.filter(function (p) { return p.credit; }).map(function (p) { return '<tr><th>' + esc(p.name) + '</th><td>' + esc(p.credit.author) + ', <a href="' + esc(p.credit.page) + '" target="_blank" rel="noopener noreferrer">' + esc(p.credit.license) + '</a></td></tr>'; }).join('');
    openModal('<h2 style="font-size:22px">Photo credits</h2><p class="sku">Product photos come from Wikimedia Commons and are used under the licences shown. Where an image is marked representative, it shows a similar generic product.</p><div style="max-height:50vh;overflow:auto"><table class="spec">' + rows + '</table></div><p><button class="btn" id="mclose">Close</button></p>');
  };

  /* ---------- start-up ---------- */
  function badge(st) {
    var b = document.querySelector('.aih span small'); if (!b) return;
    b.textContent = st.mode === 'real' ? 'AI model: ' + st.model : 'Offline assistant, no AI model key set';
  }
  function bootSession(forceNew) {
    window.VBReady = false;
    var saved = forceNew ? '' : store(TOKEN_KEY) || '';
    tok = saved;
    var step = tok ? api('GET', '/api/session') : Promise.resolve({ _status: 401 });
    return step.then(function (r) {
      if (r._status === 200) return r;
      tok = ''; store(TOKEN_KEY, null);
      return api('POST', '/api/session').then(function (n) { if (!n.token) throw new Error('no session'); tok = n.token; store(TOKEN_KEY, tok); return n; });
    }).then(function (r) {
      user = r.user; online = true; paintAccount();
      var st = r.state, localHas = Object.keys(S.cart).length || Object.keys(S.wish).length || S.recent.length;
      return loadCatalogue().then(function () {
        if (st.empty && localHas) { ready = true; adopt({ cart: cartList(), wish: S.wish, recent: S.recent, cmp: S.cmp, coupon: S.coupon }); pushState(); } // first visit with the new server: keep what was in this browser
        else { adopt(st); ready = true; }
        window.VBReady = true; // the session, catalogue and saved cart are all loaded (also used by the browser tests)
        loadRecs();
      });
    });
  }
  fetch('/api/status').then(function (r) { return r.json(); }).then(badge).catch(function () {});
  bootSession(false).catch(function () { online = false; paintAccount(); });
})();
