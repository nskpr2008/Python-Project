// SQLite storage (node:sqlite) and catalogue loading.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = new URL('..', import.meta.url);

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    pragma journal_mode = wal;
    pragma foreign_keys = on;
    create table if not exists products(
      id text primary key, name text not null, brand text, cat text not null, price int not null, stock int not null,
      reorder int not null default 0, featured int not null default 0, summary text, description text,
      highlights text, specs text, tags text, image text, image_credit text);
    create table if not exists users(
      id integer primary key, email text unique, hash text, salt text,
      role text not null default 'customer', profile text not null default 'customer',
      created integer not null, last_seen integer not null);
    create table if not exists sessions(token_hash text primary key, user_id integer not null references users(id) on delete cascade, exp integer not null);
    create table if not exists carts(user_id integer not null references users(id) on delete cascade, product_id text not null, qty integer not null, primary key(user_id, product_id));
    create table if not exists user_state(user_id integer primary key references users(id) on delete cascade, data text not null, updated integer not null);
    create table if not exists events(id integer primary key, user_id integer not null, type text not null, product_id text, q text, ts integer not null);
    create index if not exists events_user on events(user_id, ts desc);
    create table if not exists orders(id integer primary key, user_id integer not null, ts integer not null, name text, total integer not null, items text not null);
    create table if not exists tools(name text primary key, enabled int default 1);
    create table if not exists approvals(id integer primary key, user_id int, tool text, args text, status text default 'pending', ts int);
    create table if not exists audit(id integer primary key, ts int, user_id int, tool text, args text, result text, ok int);
    create table if not exists memory(user_id int, k text, v text, primary key(user_id, k));
    create table if not exists convo(id integer primary key, user_id int, role text, content text);
    create table if not exists settings(k text primary key, v text);
    create table if not exists reviews(id integer primary key, product_id text not null, user_id integer not null, rating integer not null check(rating between 1 and 5), title text, body text, ts integer not null, unique(product_id, user_id));
    create table if not exists repairs(id integer primary key, user_id integer not null, ts integer not null, name text, phone text, email text, cat text, brand text, model text, prob text, pref text, svc text, pick text,
      status text not null default 'Request received', est integer not null default 0, note text not null default '');
    create table if not exists ai_cache(k text primary key, reply text not null, ids text not null, ts integer not null);
    create index if not exists reviews_product on reviews(product_id, ts desc);
  `);
  // Small additive migrations for databases created by earlier versions.
  const addCol = (t, c, def) => { if (!db.prepare(`pragma table_info(${t})`).all().some(x => x.name === c)) db.exec(`alter table ${t} add column ${c} ${def}`); };
  addCol('products', 'source', "text not null default 'catalogue'"); // 'admin' rows were added in the admin panel and are never removed by a catalogue sync
  addCol('products', 'locked', 'int not null default 0');          // 1 once an admin edited price or reorder level, so a catalogue sync keeps the edit
  addCol('orders', 'status', "text not null default 'Pending'");
  addCol('orders', 'src', "text not null default 'Online'");
  addCol('orders', 'meta', "text not null default '{}'"); // price breakdown: subtotal, deals, coupon, add-ons
  return db;
}

const json = v => JSON.stringify(v ?? null);

/** Upserts the catalogue. Existing stock counts are kept; products no longer in the file are removed. */
export function syncCatalogue(db, file = new URL('./data/products.json', ROOT), credits = new URL('./data/image-credits.json', ROOT)) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.products || [];
  const cr = fs.existsSync(credits) ? JSON.parse(fs.readFileSync(credits, 'utf8')) : {};
  const up = db.prepare(`insert into products(id,name,brand,cat,price,stock,reorder,featured,summary,description,highlights,specs,tags,image,image_credit)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    on conflict(id) do update set name=excluded.name, brand=excluded.brand, cat=excluded.cat,
      price=case when products.locked=1 then products.price else excluded.price end,
      reorder=case when products.locked=1 then products.reorder else excluded.reorder end,
      featured=excluded.featured, summary=excluded.summary, description=excluded.description, highlights=excluded.highlights,
      specs=excluded.specs, tags=excluded.tags, image=excluded.image, image_credit=excluded.image_credit`);
  db.exec('begin');
  try {
    for (const p of list) {
      const c = cr[p.id];
      up.run(p.id, p.name, p.brand ?? '', p.cat, p.price, p.stock ?? 0, p.reorderLevel ?? p.reorder ?? 0, p.featured ? 1 : 0,
        p.summary ?? '', p.description ?? '', json(p.highlights ?? []), json(p.specs ?? {}), json(p.tags ?? []),
        c ? '/assets/products/' + c.file : '', json(c ? { author: c.author, license: c.license, licenseUrl: c.licenseUrl, page: c.page } : null));
    }
    const ids = list.map(p => p.id);
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      db.prepare(`delete from carts where product_id not in (${marks}) and product_id not in (select id from products where source='admin')`).run(...ids);
      db.prepare(`delete from products where source='catalogue' and id not in (${marks})`).run(...ids);
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
}

/** Row -> API shape. `reorder` drives the storefront's "only a few left" badge. */
export function shapeProduct(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, brand: r.brand, cat: r.cat, price: r.price, stock: r.stock, reorder: r.reorder,
    featured: !!r.featured, summary: r.summary, description: r.description,
    highlights: JSON.parse(r.highlights || '[]'), specs: JSON.parse(r.specs || '{}'), tags: JSON.parse(r.tags || '[]'),
    image: r.image || null, imageCredit: JSON.parse(r.image_credit || 'null')
  };
}

export const allProducts = db => db.prepare('select * from products order by id').all().map(shapeProduct);

// ---- passwords and tokens ----
export const normEmail = e => String(e ?? '').trim().toLowerCase();
export const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
export function checkPw(pw, salt, hash) {
  const a = Buffer.from(hashPw(pw, salt), 'hex'), b = Buffer.from(hash || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');
