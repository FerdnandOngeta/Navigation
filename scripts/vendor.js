// Copies Leaflet's dist files into public/vendor so the app shell has no CDN dependency
// (it must load with zero network once installed).
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'leaflet', 'dist');
const dest = join(root, 'public', 'vendor', 'leaflet');

if (!existsSync(src)) {
  console.error('Leaflet not found in node_modules. Run `npm install` first.');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
for (const f of ['leaflet.js', 'leaflet.css', 'images']) {
  cpSync(join(src, f), join(dest, f), { recursive: true });
}
console.log('Vendored Leaflet into public/vendor/leaflet');
