// Store-manager logic. The server sends this file only to a signed-in admin (GET /api/admin/panel.js);
// shoppers never receive it, and every action below is also checked by the server (/api/admin/*).
(function () {
  var api = window.VBApi, reload = window.VBReload, AUDIT = [], AI = null, TOOLS = [], REVIEWS = [];
  var ACT_CAT = { admin_order_status: 'Orders', admin_counter_sale: 'Orders', admin_product_add: 'Inventory', admin_product_edit: 'Inventory', admin_product_delete: 'Inventory', admin_tool_toggle: 'Admin', admin_kill_switch: 'Admin' };

  function mapOrder(o) {
    return {
      id: o.id, no: '#' + o.id, date: new Date(o.ts).toLocaleDateString('en-IN'), who: o.name || (o.email ? o.email.split('@')[0] : 'Customer'),
      items: o.items.map(function (l) { return l.name + ' ×' + l.qty; }).join(', '), total: o.total, src: o.src, status: o.status,
      cats: o.items.map(function (l) { var p = P(l.id); return [p ? p.cat : 'Other', l.price * l.qty]; })
    };
  }
  function ok(r) { if (r && r.error) { toast(r.error); return false; } return true; }

  function refresh() {
    return Promise.all([api('GET', '/api/admin/orders'), api('GET', '/api/admin/audit'), api('GET', '/api/admin/ai'), api('GET', '/api/admin/tools'), api('GET', '/api/admin/reviews'), reload(), api('GET', '/api/admin/repairs')]).then(function (r) {
      REVIEWS = Array.isArray(r[4]) ? r[4] : [];
      S.repairs = (Array.isArray(r[6]) ? r[6] : []).map(function (x) { return { id: x.ref, date: new Date(x.ts).toLocaleDateString('en-IN'), name: x.name, phone: x.phone, email: x.email, cat: x.cat, brand: x.brand, model: x.model, prob: x.prob, pref: x.pref, svc: x.svc, pick: x.pick, status: x.status, est: x.est, note: x.note }; });
      var orders = Array.isArray(r[0]) ? r[0] : [];
      S.orders = orders.map(mapOrder);
      S.products.forEach(function (p) { p.units = 0; });
      orders.forEach(function (o) { o.items.forEach(function (l) { var p = P(l.id); if (p) p.units += l.qty; }); });
      AUDIT = Array.isArray(r[1]) ? r[1] : []; AI = r[2] && !r[2].error ? r[2] : null; TOOLS = Array.isArray(r[3]) ? r[3] : [];
      renderMgr();
    });
  }
  function loadFiles() {
    return api('GET', '/api/admin/files').then(function (f) { if (!ok(f)) return; PF = f; pfCur = PF[pfCur] ? pfCur : 'README.md'; pfRender(); });
  }

  // ---- inventory (all edits go to the server) ----
  function put(id, body, msg) { return api('PUT', '/api/admin/products/' + id, body).then(function (r) { if (!ok(r)) return refresh(); toast(msg || 'Saved'); return refresh(); }); }
  $('inv').onchange = function (e) {
    var t = e.target, id = t.dataset.id; if (!id) return;
    var v = Number(t.value); if (!isFinite(v) || v < 0) { toast('Enter a whole number, 0 or more'); return refresh(); }
    var b = {}; b[t.dataset.f === 're' ? 'reorder' : t.dataset.f] = Math.round(v); put(id, b);
  };
  $('inv').onclick = function (e) {
    var id = e.target.dataset.del;
    if (id && confirm('Delete this product?')) api('DELETE', '/api/admin/products/' + id).then(function (r) { if (ok(r)) toast('Product deleted'); return refresh(); });
  };
  $('lowlist').onclick = function (e) { var id = e.target.dataset.re; if (id && P(id)) put(id, { stock: P(id).stock + 10 }, 'Restocked 10 units'); };
  $('n-add').onclick = function () {
    var n = $('n-name').value.trim(), pr = $('n-price').value;
    if (!n || pr === '' || !(Number(pr) >= 0)) { toast('Enter a name and a price'); return; }
    api('POST', '/api/admin/products', { name: n, cat: $('n-cat').value, price: Math.round(Number(pr)), stock: Math.round(Number($('n-stock').value) || 0), reorder: Math.round(Number($('n-re').value) || 0) }).then(function (r) {
      if (ok(r)) { ['n-name', 'n-price', 'n-stock'].forEach(function (i) { $(i).value = ''; }); toast('Product added'); }
      return refresh();
    });
  };

  // ---- counter billing and orders ----
  $('bill').onclick = function (e) {
    var id = e.target.dataset.bd; if (id) { delete S.bill[id]; renderMgr(); }
    if (e.target.id === 'b-pay') {
      var items = Object.keys(S.bill).map(function (k) { return { id: k, qty: S.bill[k] }; }); if (!items.length) return;
      e.target.disabled = true;
      api('POST', '/api/admin/counter-sale', { items: items, name: 'Walk-in' }).then(function (r) {
        if (ok(r)) { S.bill = {}; toast('Sale #' + r.order.id + ' completed'); }
        return refresh();
      });
    }
  };
  $('ords').onchange = function (e) {
    var i = e.target.dataset.os; if (i === undefined || !S.orders[i]) return;
    api('POST', '/api/admin/orders/' + S.orders[i].id + '/status', { status: e.target.value }).then(function (r) { if (ok(r)) toast('Status updated'); return refresh(); });
  };

  // ---- repairs: bookings made by customers, stored on the server ----
  $('repl').onchange = function (e) {
    var t = e.target, ix = t.dataset.rs !== undefined ? t.dataset.rs : t.dataset.re2 !== undefined ? t.dataset.re2 : t.dataset.rn, r = S.repairs[+ix]; if (!r) return;
    var body = t.dataset.rs !== undefined ? { status: t.value } : t.dataset.re2 !== undefined ? { est: Math.max(0, Math.round(Number(t.value) || 0)) } : { note: t.value };
    api('PUT', '/api/admin/repairs/' + encodeURIComponent(r.id), body).then(function (x) { if (ok(x)) toast('Repair updated'); return refresh(); });
  };

  // ---- activity feed: the server's audit log ----
  var actf = $('actf');
  if (actf) actf.innerHTML = '<option value="">All</option><option>Orders</option><option>Inventory</option><option>Admin</option><option>AI</option>';
  var note = document.querySelector('#t-act .sku'); if (note) note.textContent = 'Live audit log from the server: admin actions and every tool call VoltAI makes.';
  $('actr').onclick = refresh;
  renderAct = function () {
    var f = $('actf').value, q = $('actq').value.toLowerCase();
    var l = AUDIT.map(function (a) { return { c: ACT_CAT[a.tool] || 'AI', t: a.ts, x: a.tool.replace(/^admin_/, '').replace(/_/g, ' ') + ' ' + (a.args || ''), ok: a.ok }; })
      .filter(function (a) { return (!f || a.c === f) && a.x.toLowerCase().indexOf(q) > -1; });
    $('actl').innerHTML = l.length ? l.map(function (a) {
      var d = new Date(a.t);
      return '<div class="ln"><span><b>' + a.c + '</b> ' + esc(a.x.slice(0, 160)) + (a.ok ? '' : ' <b class="out">failed</b>') + '</span><small class="sku">' + d.toLocaleDateString('en-IN') + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + '</small></div>';
    }).join('') : '<p>No activity recorded yet.</p>';
  };

  // ---- AI control: usage, kill switch, tool switches ----
  if (!SUBS.some(function (s) { return s[0] === 'ai'; })) SUBS.splice(6, 0, ['ai', 'AI control']);
  if (!SUBS.some(function (s) { return s[0] === 'rev'; })) SUBS.splice(4, 0, ['rev', 'Reviews']);
  if (!$('t-rev')) { var rv = document.createElement('div'); rv.id = 't-rev'; rv.className = 'hide'; $('mgr').appendChild(rv); }
  function renderReviews() {
    var el = $('t-rev'); if (!el) return;
    el.innerHTML = '<div class="panel"><h2 style="font-size:18px;margin-bottom:6px">Customer reviews</h2><p class="sku">Only verified buyers can post. Remove a review that breaks your rules.</p>' + (REVIEWS.length ? REVIEWS.map(function (r) {
      return '<div class="ln"><span><b>' + '★'.repeat(r.rating) + '</b> ' + esc(r.product || r.product_id) + '<br><small class="sku">' + esc(r.title || '') + ' ' + esc(r.body) + ' (' + esc((r.email || '').split('@')[0]) + ')</small></span><button class="btn alt" data-rdel="' + r.id + '">Remove</button></div>';
    }).join('') : '<p>No reviews yet.</p>') + '</div>';
  }
  document.addEventListener('click', function (e) { var id = e.target.dataset && e.target.dataset.rdel; if (id && confirm('Remove this review?')) api('DELETE', '/api/admin/reviews/' + id).then(function (r) { if (ok(r)) toast('Review removed'); refresh(); }); });
  if (!$('t-ai')) { var d = document.createElement('div'); d.id = 't-ai'; d.className = 'hide'; $('mgr').appendChild(d); }
  function renderAI() {
    var el = $('t-ai'); if (!el || !AI) return;
    var pct = Math.min(100, Math.round(AI.used / Math.max(1, AI.limit) * 100));
    el.innerHTML = '<div class="panel"><h2 style="font-size:18px;margin-bottom:6px">VoltAI</h2>' +
      '<p class="sku" style="margin:0 0 8px">' + (AI.model ? 'Model: <b>' + esc(AI.provider) + ' / ' + esc(AI.model) + '</b>' : 'No model key set: the built-in offline assistant is answering.') + '</p>' +
      '<div class="bar"><span>Model requests today</span><i style="width:' + pct + '%"></i><span>' + AI.used + ' / ' + AI.limit + '</span></div>' +
      '<p class="sku">Answers reused from the cache today (no quota spent): ' + (AI.cacheHits || 0) + '.</p><p class="sku">Each shopper may use ' + AI.userDaily + ' AI answers a day. When a limit is reached VoltAI keeps answering from the offline assistant.</p>' +
      '<p><button class="btn' + (AI.ai_enabled ? '' : ' alt') + '" id="ai-kill">' + (AI.ai_enabled ? 'Switch VoltAI off' : 'Switch VoltAI on') + '</button></p></div>' +
      '<div class="panel"><h2 style="font-size:18px;margin-bottom:6px">Tools VoltAI may use</h2>' + TOOLS.map(function (t) {
        return '<div class="ln"><span><b>' + esc(t.name) + '</b> <small class="sku">' + (t.approval ? 'needs shopper confirmation' : t.level >= 3 ? 'admin only' : 'read only') + '</small></span><button class="chip" data-tool="' + esc(t.name) + '" aria-pressed="' + t.enabled + '">' + (t.enabled ? 'On' : 'Off') + '</button></div>';
      }).join('') + '</div>';
  }
  document.addEventListener('click', function (e) {
    var el = e.target; if (!$('t-ai') || !$('t-ai').contains(el)) return;
    if (el.id === 'ai-kill') api('POST', '/api/admin/kill', { enabled: !AI.ai_enabled }).then(function (r) { if (ok(r)) refresh(); });
    if (el.dataset.tool) api('POST', '/api/admin/tools/' + el.dataset.tool, { enabled: el.getAttribute('aria-pressed') !== 'true' }).then(function (r) { if (ok(r)) refresh(); });
  });
  var _rm = renderMgr; renderMgr = function () { _rm(); renderAI(); renderAct(); renderReviews(); };

  window.VBAdmin = { open: function (m) { return m === 'files' ? loadFiles() : refresh(); }, refresh: refresh };
})();
