// Downloads one product photo per catalogue entry from Wikimedia Commons and records its licence.
// Usage: node scripts/fetch-images.mjs   (idempotent: skips images that are already on disk)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'assets', 'products');
const creditsFile = path.join(root, 'data', 'image-credits.json');
const UA = { 'user-agent': 'VoltBayCatalogueBuilder/1.0 (local development; contact: store owner)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();

async function getJson(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: UA });
    const t = await r.text();
    try { return JSON.parse(t); } catch { await sleep(8000 * (i + 1)); }
  }
  throw new Error('Commons API kept refusing: ' + url.slice(0, 80));
}

const products = JSON.parse(fs.readFileSync(path.join(root, 'data', 'products.json'), 'utf8')).products;
const credits = fs.existsSync(creditsFile) ? JSON.parse(fs.readFileSync(creditsFile, 'utf8')) : {};
fs.mkdirSync(outDir, { recursive: true });

const todo = products.filter(p => !credits[p.id] || !fs.existsSync(path.join(outDir, credits[p.id].file)));
console.log(`${products.length - todo.length} already done, ${todo.length} to fetch`);
for (let i = 0; i < todo.length; i += 10) {
  const batch = todo.slice(i, i + 10);
  const titles = batch.map(p => p.image.commons).join('|');
  const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=640&titles=' + encodeURIComponent(titles);
  const j = await getJson(api);
  const norm = new Map((j.query.normalized || []).map(n => [n.from, n.to]));
  const byTitle = new Map(Object.values(j.query.pages).map(pg => [pg.title, pg]));
  for (const p of batch) {
    const want = p.image.commons, pg = byTitle.get(norm.get(want) || want);
    const info = pg?.imageinfo?.[0];
    if (!info) { console.error('MISSING on Commons:', want); process.exitCode = 1; continue; }
    const md = info.extmetadata || {};
    let file = null;
    for (let k = 0; k < 5 && !file; k++) {
      const r = await fetch(info.thumburl || info.url, { headers: UA });
      const type = r.headers.get('content-type') || '';
      if (r.ok && type.startsWith('image/')) {
        const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
        file = `${p.id}.${ext}`;
        fs.writeFileSync(path.join(outDir, file), Buffer.from(await r.arrayBuffer()));
      } else await sleep(6000 * (k + 1));
      await sleep(1500);
    }
    if (!file) { console.error('DOWNLOAD FAILED:', want); process.exitCode = 1; continue; }
    credits[p.id] = {
      file, commonsTitle: want, page: info.descriptionurl,
      author: strip(md.Artist?.value) || 'Unknown', license: strip(md.LicenseShortName?.value) || 'See page',
      licenseUrl: md.LicenseUrl?.value || null
    };
    console.log('ok', p.id, file, credits[p.id].license);
  }
  fs.writeFileSync(creditsFile, JSON.stringify(credits, null, 2));
  await sleep(4000);
}
