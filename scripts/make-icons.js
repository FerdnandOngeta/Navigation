// Generates the PWA PNG icons with no image libraries (raw RGBA -> PNG via zlib).
// Design: green rounded square with a white compass needle.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const t = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if ((s < 0) !== (t < 0) && s !== 0 && t !== 0) return false;
  const d = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  return d === 0 || (d < 0) === (s + t <= 0);
}

function makeIcon(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const pad = maskable ? 0 : size * 0.06;
  const radius = maskable ? 0 : size * 0.2;
  const c = size / 2;
  const scale = maskable ? 0.62 : 0.8; // maskable icons need a safe zone
  const top = [c, c - size * 0.36 * scale];
  const bottom = [c, c + size * 0.36 * scale];
  const left = [c - size * 0.13 * scale, c];
  const right = [c + size * 0.13 * scale, c];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-rect background
      const dx = Math.max(pad + radius - x, 0, x - (size - pad - radius));
      const dy = Math.max(pad + radius - y, 0, y - (size - pad - radius));
      const inside = x >= pad && x < size - pad && y >= pad && y < size - pad && dx * dx + dy * dy <= radius * radius;
      if (!inside) continue;
      let [r, g, b] = [0x14, 0x6c, 0x43];
      const ring = Math.hypot(x - c, y - c);
      if (Math.abs(ring - size * 0.4 * scale) < size * 0.018) [r, g, b] = [0xd8, 0xf3, 0xdc];
      if (inTriangle(x, y, top, left, right)) [r, g, b] = [0xff, 0xff, 0xff];
      if (inTriangle(x, y, bottom, left, right)) [r, g, b] = [0xf4, 0xa2, 0x61];
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size, maskable] of [
  ['icon-192.png', 192, false], ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true],
]) {
  writeFileSync(join(outDir, name), makeIcon(size, maskable));
  console.log('wrote', name);
}
