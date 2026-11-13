// Pure geo helpers — no DOM, no Leaflet — so they can be unit tested in Node.

const R = 6371008.8; // mean Earth radius, metres
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function distance(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing from point 1 to point 2, degrees clockwise from true north. */
export function bearing(lat1, lng1, lat2, lng2) {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function compassLabel(deg) {
  const labels = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return labels[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export function formatDistance(m) {
  if (!Number.isFinite(m)) return '–';
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Shortest distance (m) from a point to a polyline of [lat, lng] pairs. Uses a local flat projection. */
export function distanceToPolyline(lat, lng, line) {
  if (!line || line.length === 0) return Infinity;
  if (line.length === 1) return distance(lat, lng, line[0][0], line[0][1]);
  const kx = Math.cos(toRad(lat)) * (Math.PI / 180) * R;
  const ky = (Math.PI / 180) * R;
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][1] - lng) * kx, ay = (line[i][0] - lat) * ky;
    const bx = (line[i + 1][1] - lng) * kx, by = (line[i + 1][0] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// ---- Slippy-map tile maths (Web Mercator, z/x/y) ----

export function lngToTileX(lng, z) {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}
export function latToTileY(lat, z) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const r = toRad(clamped);
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

function tileRange(b, z) {
  const max = 2 ** z - 1;
  return {
    x0: Math.max(0, lngToTileX(b.west, z)), x1: Math.min(max, lngToTileX(b.east, z)),
    y0: Math.max(0, latToTileY(b.north, z)), y1: Math.min(max, latToTileY(b.south, z)),
  };
}

/** Number of tiles covering bounds {south, west, north, east} for each zoom in [zMin, zMax]. */
export function countTiles(b, zMin, zMax) {
  let n = 0;
  for (let z = zMin; z <= zMax; z++) {
    const r = tileRange(b, z);
    n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  }
  return n;
}

export function* tilesInBounds(b, zMin, zMax) {
  for (let z = zMin; z <= zMax; z++) {
    const r = tileRange(b, z);
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield { z, x, y };
  }
}

/** Bounds of a box `radius` metres around a point. */
export function boundsAround(lat, lng, radius) {
  const dLat = toDeg(radius / R);
  const dLng = toDeg(radius / (R * Math.cos(toRad(lat))));
  return { south: lat - dLat, north: lat + dLat, west: lng - dLng, east: lng + dLng };
}

/** Unique tiles covering a corridor of `buffer` metres either side of a route line. */
export function corridorTiles(line, buffer, zMin, zMax) {
  const seen = new Map();
  const step = Math.max(buffer, 50);
  const samples = [];
  for (let i = 0; i < line.length; i++) {
    samples.push(line[i]);
    if (i < line.length - 1) {
      const d = distance(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
      const n = Math.floor(d / step);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        samples.push([line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t]);
      }
    }
  }
  for (const [lat, lng] of samples) {
    for (const t of tilesInBounds(boundsAround(lat, lng, buffer), zMin, zMax)) {
      seen.set(`${t.z}/${t.x}/${t.y}`, t);
    }
  }
  return [...seen.values()];
}

/** Parse "lat, lng" typed into the search box (decimal degrees). Returns null if not coordinates. */
export function parseCoordinates(text) {
  const m = String(text).trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
