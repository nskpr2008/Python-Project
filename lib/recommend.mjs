// Personalised recommendations. Everything is derived from what the visitor actually did
// (views, searches, saved items, cart, remembered preferences); nothing is invented.
import { allProducts } from './db.mjs';

const DAY = 864e5;
const WEIGHT = { view: 1, search: 0.6, wish: 2.5, cart: 3, compare: 1.5, order: 3 };
// Categories that are bought together with a device.
const COMPLEMENTS = {
  Phones: ['Accessories', 'Audio', 'Wearables'],
  Laptops: ['Accessories', 'Headsets', 'Audio'],
  Headsets: ['Accessories'],
  Audio: ['Accessories', 'Wearables'],
  Wearables: ['Accessories', 'Audio'],
  Accessories: ['Phones', 'Laptops'],
  'Smart home': ['Smart home'],
  Gaming: ['Gaming', 'Headsets', 'Accessories']
};
// Search words -> catalogue category / tag, so a typed "earbuds" counts as interest even when nothing was opened.
const WORDS = {
  phone: ['cat:Phones'], mobile: ['cat:Phones'], smartphone: ['cat:Phones'], iphone: ['cat:Phones'],
  laptop: ['cat:Laptops'], macbook: ['cat:Laptops'], notebook: ['cat:Laptops'],
  headphone: ['cat:Headsets'], headphones: ['cat:Headsets'], headset: ['cat:Headsets'],
  earbuds: ['cat:Audio'], speaker: ['cat:Audio'], earphones: ['cat:Audio'],
  watch: ['cat:Wearables'], band: ['cat:Wearables'], fitness: ['cat:Wearables', 'tag:fitness'],
  charger: ['cat:Accessories'], cable: ['cat:Accessories'], powerbank: ['cat:Accessories'],
  camera: ['tag:camera'], bulb: ['cat:Smart home'], gaming: ['cat:Gaming', 'tag:gaming'], console: ['cat:Gaming'], controller: ['cat:Gaming'],
  keyboard: ['cat:Gaming'], mouse: ['cat:Gaming'], monitor: ['cat:Gaming'], xbox: ['cat:Gaming'], playstation: ['cat:Gaming'], ps5: ['cat:Gaming'], vr: ['cat:Gaming'], travel: ['tag:travel'], budget: ['tag:budget'],
  student: ['tag:student'], office: ['tag:office'], anc: ['tag:anc'], wireless: ['tag:wireless']
};

const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
const wMedian = pairs => {
  if (!pairs.length) return null;
  const s = [...pairs].sort((a, b) => a[0] - b[0]), total = s.reduce((t, x) => t + x[1], 0);
  let acc = 0;
  for (const [v, w] of s) { acc += w; if (acc >= total / 2) return v; }
  return s.at(-1)[0];
};

/** Builds a taste profile from a user's events, cart and remembered preferences. */
export function buildProfile(db, userId, now = Date.now()) {
  const products = new Map(allProducts(db).map(p => [p.id, p]));
  const cats = new Map(), brands = new Map(), tags = new Map(), prices = [], seen = new Set(), signals = [];
  let softBudget = null;
  const add = (p, w, why) => {
    if (!p) return;
    bump(cats, p.cat, w); if (p.brand && p.brand !== 'Unbranded') bump(brands, p.brand, w);
    for (const t of p.tags) bump(tags, t, w * 0.6);
    prices.push([p.price, w]); seen.add(p.id); signals.push({ p, w, why });
  };
  const ev = db.prepare('select type, product_id, q, ts from events where user_id=? order by ts desc limit 300').all(userId);
  for (const e of ev) {
    const decay = Math.pow(0.5, (now - e.ts) / (14 * DAY)); // half-life: two weeks
    if (e.product_id) add(products.get(e.product_id), (WEIGHT[e.type] || 0.5) * decay, e.type);
    if (e.q) {
      for (const w of e.q.toLowerCase().split(/[^a-z0-9]+/)) for (const hit of WORDS[w] || []) {
        const [kind, val] = hit.split(':'); bump(kind === 'cat' ? cats : tags, val, WEIGHT.search * decay);
      }
      const b = e.q.toLowerCase().replace(/,/g, '').match(/(?:under|below|within|upto|up to|less than|max)\s*₹?\s*(\d+)\s*(k)?\b/);
      if (b && softBudget == null) softBudget = +b[1] * (b[2] ? 1000 : 1); // newest search wins (events are newest first)
    }
  }
  const cart = db.prepare('select product_id, qty from carts where user_id=?').all(userId);
  for (const c of cart) add(products.get(c.product_id), WEIGHT.cart, 'cart');
  const mem = Object.fromEntries(db.prepare('select k, v from memory where user_id=?').all(userId).map(r => [r.k, r.v]));
  const inCart = new Set(cart.map(c => c.product_id));
  const budget = Number(mem.budget || mem.max_budget) || null;
  return { cats, brands, tags, anchor: wMedian(prices), seen, inCart, signals, memory: mem, budget, softBudget, hasSignals: signals.length > 0 || cats.size > 0 };
}

/** Human readable summary used to ground the AI assistant. */
export function profileSummary(profile) {
  const top = m => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
  return {
    interested_categories: top(profile.cats), preferred_brands: top(profile.brands), interests: top(profile.tags),
    typical_price_inr: profile.anchor ? Math.round(profile.anchor) : null, stated_preferences: profile.memory
  };
}

export function recommend(db, userId, { limit = 6, exclude = [], category = null, now = Date.now() } = {}) {
  const profile = buildProfile(db, userId, now), all = allProducts(db);
  const skip = new Set([...exclude, ...profile.inCart]);
  const cartProducts = all.filter(p => profile.inCart.has(p.id));
  const maxCat = Math.max(1, ...profile.cats.values()), maxBrand = Math.max(1, ...profile.brands.values()), maxTag = Math.max(1, ...profile.tags.values());
  const cap = profile.budget || null;
  const recentSignal = profile.signals.filter(s => s.why !== 'cart').sort((a, b) => b.w - a.w)[0]?.p;

  const scored = [];
  for (const p of all) {
    if (skip.has(p.id) || p.stock <= 0 || (category && p.cat !== category)) continue;
    let s = 0, reason = '';
    const parts = [];
    const cat = (profile.cats.get(p.cat) || 0) / maxCat; if (cat) { s += 3 * cat; parts.push([3 * cat, recentSignal && recentSignal.cat === p.cat ? `Because you looked at ${recentSignal.name}` : `You've been browsing ${p.cat.toLowerCase()}`]); }
    const br = (profile.brands.get(p.brand) || 0) / maxBrand; if (br) { s += 1.2 * br; parts.push([1.2 * br, `You often look at ${p.brand}`]); }
    const tg = p.tags.reduce((t, x) => t + (profile.tags.get(x) || 0), 0) / (maxTag * 2); if (tg) s += Math.min(tg, 1.5);
    if (profile.anchor) {
      const d = Math.abs(Math.log(p.price / profile.anchor));
      const fit = 2 * Math.exp(-d * d / 1.5); s += fit;
      if (fit > 1.4) parts.push([fit * 0.7, 'Close to your usual price range']);
    }
    for (const c of cartProducts) {
      if ((COMPLEMENTS[c.cat] || []).includes(p.cat) && p.id !== c.id) {
        let b = 1.6;
        if (p.tags.includes('usb-c') && c.tags.includes('usb-c')) b += 0.9;
        if (p.tags.includes('ios') && c.tags.includes('ios')) b += 0.9;
        if (p.tags.includes('android') && c.tags.includes('android')) b += 0.5;
        s += b; parts.push([b, `Goes with ${c.name} in your cart`]);
      }
    }
    if (profile.seen.has(p.id)) s -= 1.5; // already looked at: it is in "recently viewed", so favour something new
    if (!cap && profile.softBudget && p.price > profile.softBudget * 1.1) s -= 3; // they searched "under N" recently, and the newest explicit request beats older browsing
    if (cap && p.price > cap) s -= 6; // a stated budget is close to a hard limit: over-budget items only fill empty slots
    else if (cap) parts.push([0.5, `Within your ₹${cap.toLocaleString('en-IN')} budget`]);
    if (p.featured) { s += 0.35; parts.push([0.2, 'Staff pick']); }
    if (!profile.hasSignals) s += p.featured ? 1 : 0;
    parts.sort((a, b) => b[0] - a[0]);
    reason = parts[0]?.[1] || (profile.hasSignals ? 'Popular with shoppers who browse like you' : 'Staff pick');
    if (!profile.hasSignals && !p.featured) reason = 'Worth a look';
    scored.push({ p, s, reason });
  }
  scored.sort((a, b) => b.s - a.s || a.p.price - b.p.price);
  // Keep the shelf varied: at most two per category until the list is otherwise full.
  const out = [], perCat = new Map();
  for (const x of scored) { if ((perCat.get(x.p.cat) || 0) >= 2) continue; out.push(x); bump(perCat, x.p.cat, 1); if (out.length >= limit) break; }
  for (const x of scored) { if (out.length >= limit) break; if (!out.includes(x)) out.push(x); }
  return { personalised: profile.hasSignals, items: out.map(x => ({ id: x.p.id, score: +x.s.toFixed(2), reason: x.reason })) };
}

/** Similar products: same category first, then shared tags and price proximity. */
export function related(db, id, limit = 4) {
  const all = allProducts(db), base = all.find(p => p.id === id);
  if (!base) return [];
  return all.filter(p => p.id !== id && p.stock > 0).map(p => {
    const shared = p.tags.filter(t => base.tags.includes(t)).length;
    const d = Math.abs(Math.log(p.price / base.price));
    const comp = (COMPLEMENTS[base.cat] || []).includes(p.cat) && p.cat !== base.cat ? 0.8 : 0;
    return { id: p.id, s: (p.cat === base.cat ? 2 : 0) + shared * 0.7 + 1.5 * Math.exp(-d * d) + comp, reason: p.cat === base.cat ? `Similar to ${base.name}` : `Goes with ${base.name}` };
  }).sort((a, b) => b.s - a.s).slice(0, limit).map(({ id, reason }) => ({ id, reason }));
}
