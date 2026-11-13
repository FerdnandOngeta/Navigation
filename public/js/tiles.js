// Offline-first map tiles.
// Every tile is read from the Cache API first and only fetched from the network when
// online. Missing tiles are drawn by scaling up a cached lower-zoom "ancestor" tile, so a
// region saved at zoom 15 still shows (blurry but usable) map at zoom 18 with no signal.
/* global L */
import { network } from './network.js';
import { tilesInBounds, boundsAround, countTiles } from './geo.js';

const CACHE = 'fn-tiles-v1';

export const PROVIDERS = {
  streets: {
    id: 'streets', name: 'Streets', maxNativeZoom: 19, avgKB: 18, maxConnections: 2,
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    // OSM's volunteer-run servers forbid heavy bulk downloads; keep "Save area" small.
    bulkLimit: 3000,
  },
  topo: {
    id: 'topo', name: 'Terrain', maxNativeZoom: 17, avgKB: 25, maxConnections: 2,
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', subdomains: 'abc',
    attribution: 'Map data &copy; OpenStreetMap contributors, SRTM | Style &copy; OpenTopoMap (CC-BY-SA)',
    bulkLimit: 3000,
  },
  satellite: {
    id: 'satellite', name: 'Satellite', maxNativeZoom: 19, avgKB: 30, maxConnections: 4,
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    overlays: ['roads', 'labels'], bulkLimit: 15000,
  },
  roads: {
    id: 'roads', name: 'Roads overlay', maxNativeZoom: 19, avgKB: 6, maxConnections: 4, overlay: true,
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    attribution: '',
  },
  labels: {
    id: 'labels', name: 'Place labels', maxNativeZoom: 19, avgKB: 5, maxConnections: 4, overlay: true,
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution: '',
  },
};

/** An organisation's own tile server (or a keyed commercial one) — no bulk limit. */
export function setCustomProvider(url) {
  if (url) {
    PROVIDERS.custom = {
      id: 'custom', name: 'Custom', url, subdomains: 'abc', maxNativeZoom: 19, avgKB: 20,
      maxConnections: 6, attribution: 'Custom tiles', bulkLimit: 50000,
    };
  } else delete PROVIDERS.custom;
}

export function tileUrl(p, z, x, y) {
  // Deterministic subdomain so the same tile always has the same cache key.
  const s = p.subdomains ? p.subdomains[(x + y) % p.subdomains.length] : '';
  return p.url.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', '');
}

let cachePromise;
const tileCache = () => (cachePromise ??= caches.open(CACHE));

// ---- network fetching with a concurrency gate tuned to connection quality ----
const LIMITS = { offline: 0, poor: 2, fair: 4, good: 8 };
let active = 0;
const waiting = [];
const acquire = () => new Promise((resolve) => {
  if (active < Math.max(1, LIMITS[network.quality])) { active++; resolve(); } else waiting.push(resolve);
});
const release = () => {
  active--;
  if (waiting.length && active < Math.max(1, LIMITS[network.quality])) { active++; waiting.shift()(); }
};

const recentFailures = new Map(); // url -> time; avoid hammering a dead tower

async function fetchAndStore(url, { signal, timeout }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { mode: 'cors', signal: ctrl.signal, credentials: 'omit' });
    network.record(performance.now() - t0, res.ok);
    if (!res.ok) return null;
    const blob = await res.blob();
    await (await tileCache()).put(url, new Response(blob, { headers: { 'Content-Type': blob.type || 'image/png' } }));
    return blob;
  } catch {
    if (!signal?.aborted) network.record(timeout, false);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function getTile(p, z, x, y, { allowNetwork = true, signal } = {}) {
  const url = tileUrl(p, z, x, y);
  const hit = await (await tileCache()).match(url);
  if (hit) return hit.blob();
  if (!allowNetwork || !network.online || signal?.aborted) return null;
  const failedAt = recentFailures.get(url);
  if (failedAt && Date.now() - failedAt < 60000) return null;
  await acquire();
  try {
    if (signal?.aborted) return null;
    const blob = await fetchAndStore(url, { signal, timeout: network.quality === 'poor' ? 25000 : 12000 });
    if (!blob && !signal?.aborted) recentFailures.set(url, Date.now());
    return blob;
  } finally {
    release();
  }
}

async function drawBlob(canvas, blob, sub) {
  const bmp = await createImageBitmap(blob);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  if (sub) ctx.drawImage(bmp, sub.sx, sub.sy, sub.size, sub.size, 0, 0, canvas.width, canvas.height);
  else ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
}

function drawEmpty(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e9ece6';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#d5dad0';
  ctx.lineWidth = 1;
  for (let i = 0; i <= canvas.width; i += 64) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke();
  }
}

async function renderTile(canvas, p, z, x, y, signal, isOverlay) {
  try {
    const blob = await getTile(p, z, x, y, { signal });
    if (signal.aborted) return;
    if (blob) { await drawBlob(canvas, blob); return; }
    for (let dz = 1; dz <= 10 && z - dz >= 0; dz++) {
      const ancestor = await getTile(p, z - dz, x >> dz, y >> dz, { allowNetwork: false });
      if (ancestor) {
        const scale = 2 ** dz;
        const size = 256 / scale;
        await drawBlob(canvas, ancestor, { sx: (x - (x >> dz) * scale) * size, sy: (y - (y >> dz) * scale) * size, size });
        return;
      }
    }
    if (!isOverlay) drawEmpty(canvas);
  } catch {
    if (!isOverlay) drawEmpty(canvas);
  }
}

export const OfflineTileLayer = L.TileLayer.extend({
  initialize(provider, options) {
    this._provider = provider;
    L.TileLayer.prototype.initialize.call(this, '', {
      maxNativeZoom: provider.maxNativeZoom,
      maxZoom: 21,
      attribution: provider.attribution,
      keepBuffer: 1,
      ...options,
    });
    this.on('tileunload tileabort', (e) => e.tile?._ctrl?.abort());
  },
  createTile(coords, done) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 256;
    tile._ctrl = new AbortController();
    const z = this._getZoomForUrl();
    renderTile(tile, this._provider, z, coords.x, coords.y, tile._ctrl.signal, !!this._provider.overlay)
      .then(() => { tile.complete = true; done(null, tile); });
    return tile;
  },
});

/** Base layer plus any overlays (e.g. roads + labels on satellite). */
export function createLayer(providerId, { detailed = false } = {}) {
  const p = PROVIDERS[providerId] || PROVIDERS.streets;
  // On a good connection request 2x tiles on high-DPI phones for crisper detail.
  const retina = detailed && window.devicePixelRatio > 1;
  const group = L.layerGroup([new OfflineTileLayer(p, { detectRetina: retina })]);
  for (const id of p.overlays || []) group.addLayer(new OfflineTileLayer(PROVIDERS[id], { detectRetina: retina, pane: 'labels' }));
  return group;
}

export function providerSet(providerId) {
  const p = PROVIDERS[providerId] || PROVIDERS.streets;
  return [p, ...(p.overlays || []).map((id) => PROVIDERS[id])];
}

export function estimateDownload(providerId, bounds, zMin, zMax) {
  const tiles = countTiles(bounds, zMin, zMax);
  const set = providerSet(providerId);
  return {
    tiles,
    requests: tiles * set.length,
    mb: (tiles * set.reduce((s, p) => s + p.avgKB, 0)) / 1024,
    limit: set[0].bulkLimit,
  };
}

/**
 * Downloads tiles for offline use, skipping ones already cached. Retries on flaky links.
 * `tiles` is an iterable of {z,x,y}. Returns { saved, skipped, failed }.
 */
export async function downloadTiles(providerId, tiles, { onProgress, signal } = {}) {
  const set = providerSet(providerId);
  const list = [];
  for (const t of tiles) for (const p of set) list.push({ p, ...t });
  const stats = { total: list.length, done: 0, saved: 0, skipped: 0, failed: 0 };
  const cache = await tileCache();
  let next = 0;
  const concurrency = Math.max(1, Math.min(set[0].maxConnections, LIMITS[network.quality] || 1));

  async function worker() {
    while (next < list.length && !signal?.aborted) {
      const { p, z, x, y } = list[next++];
      const url = tileUrl(p, z, x, y);
      if (await cache.match(url)) stats.skipped++;
      else {
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok && !signal?.aborted; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
          ok = !!(await fetchAndStore(url, { signal, timeout: 30000 }));
        }
        ok ? stats.saved++ : stats.failed++;
      }
      stats.done++;
      onProgress?.(stats);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return stats;
}

/** Small aerial + street patch around a destination, so its "what it looks like" view works offline. */
export function cacheAroundPoint(lat, lng, providerIds = ['satellite', 'streets'], zMax = 18) {
  const tiles = [...tilesInBounds(boundsAround(lat, lng, 350), 14, zMax)];
  return Promise.all(providerIds.map((id) => downloadTiles(id, tiles)));
}

export async function tileStats() {
  const keys = await (await tileCache()).keys();
  const est = (await navigator.storage?.estimate?.()) || {};
  return { tiles: keys.length, usage: est.usage || 0, quota: est.quota || 0 };
}

export const clearTiles = () => caches.delete(CACHE).then(() => { cachePromise = null; });
