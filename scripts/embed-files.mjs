// Refreshes the "Project files" viewer data. The bundle is written to data/project-files.json, which is NOT under public/:
// the server hands it only to a signed-in admin (GET /api/admin/files), so the source code is not exposed to shoppers.
// Usage: node scripts/embed-files.mjs   (run it after editing any of the listed files)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['README.md', 'package.json', '.env.example', '.gitignore', 'server.mjs', 'lib/db.mjs', 'lib/ai.mjs', 'lib/recommend.mjs',
  'public/app.js', 'data/products.json', 'data/db_schema_reference.sql', 'data/db_seed_reference.sql', 'tests/api.test.mjs'];
const bundle = Object.fromEntries(files.filter(f => fs.existsSync(path.join(root, f))).map(f => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
fs.writeFileSync(path.join(root, 'data', 'project-files.json'), JSON.stringify(bundle));
// Make sure no old copy of the sources is still embedded in the public page.
const page = path.join(root, 'public', 'index.html');
const lines = fs.readFileSync(page, 'utf8').split('\n');
const i = lines.findIndex(l => l.startsWith('var PF='));
if (i >= 0 && lines[i].length > 200) { lines[i] = 'var PF={},pfCur="README.md";'; fs.writeFileSync(page, lines.join('\n')); }
console.log(`bundled ${Object.keys(bundle).length} files for the admin viewer`);
