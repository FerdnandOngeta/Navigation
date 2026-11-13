import { distance } from './geo.js';

// Import pipeline (pure, no DOM — unit tested):
//   readTable()        file text  -> { columns, rows }   (or an app export bundle)
//   guessMapping()     columns    -> which column is latitude, longitude, name, …
//   verifyCoordinates  rows+map   -> are these really GPS coordinates? (report shown to the user)
//   applyMapping()     rows+map   -> location records, keeping every original column in `fields`

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text).replace(/^﻿/, '');
  // Excel in some locales saves "CSV" with semicolons.
  const firstLine = s.slice(0, s.indexOf('\n') === -1 ? s.length : s.indexOf('\n'));
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';'
    : (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v);
  }
  return out;
};

/**
 * Returns either { kind: 'bundle', locations, photos } for a Field Navigator export, or
 * { kind: 'table', columns, rows } where rows are { column: stringValue } objects.
 */
export function readTable(text, filename = '') {
  const trimmed = String(text).trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    if (data && data.app === 'field-navigator') {
      return { kind: 'bundle', locations: data.locations || [], photos: data.photos || [], datasets: data.datasets || [] };
    }
    const items = Array.isArray(data) ? data : data.type === 'FeatureCollection' ? data.features : [data];
    const rows = [];
    for (const item of items) {
      if (item && item.type === 'Feature') {
        const row = flatten(item.properties);
        if (item.geometry?.type === 'Point') {
          row.geometry_latitude = String(item.geometry.coordinates[1]);
          row.geometry_longitude = String(item.geometry.coordinates[0]);
        }
        rows.push(row);
      } else if (item && typeof item === 'object') rows.push(flatten(item));
    }
    return { kind: 'table', columns: unionColumns(rows), rows };
  }
  if (/\.(geo)?json$/i.test(filename)) throw new Error('File is not valid JSON');
  const raw = parseCSV(trimmed);
  const header = (raw.shift() || []).map((h, i) => h.trim() || `column_${i + 1}`);
  // Make duplicate headers unique so no column is silently lost.
  const seen = {};
  const columns = header.map((h) => { seen[h] = (seen[h] || 0) + 1; return seen[h] > 1 ? `${h}_${seen[h]}` : h; });
  const rows = raw.map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? '').trim()])));
  return { kind: 'table', columns, rows };
}

function unionColumns(rows) {
  const set = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => set.add(k)));
  return [...set];
}

// ---------------------------------------------------------------- coordinate parsing

/**
 * Decimal degrees ("-0.0917", "34,768" with a decimal comma) or degrees-minutes-seconds
 * ("0°05'30\"S", "S 0 5 30", "34 46.08 E"). Returns a number or NaN.
 */
export function parseCoordValue(v) {
  if (v == null) return NaN;
  let s = String(v).trim();
  if (!s) return NaN;
  if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  if (/^[+-]?\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) return Number(s);
  const m = s.match(/^([NSEW])?\s*([+-]?\d+(?:\.\d+)?)\s*[°º:\s]\s*(\d+(?:\.\d+)?)?\s*['′:\s]?\s*(\d+(?:\.\d+)?)?\s*["″]?\s*([NSEW])?$/i);
  if (!m) return NaN;
  const [, h1, d, min = '0', sec = '0', h2] = m;
  let val = Math.abs(Number(d)) + Number(min) / 60 + Number(sec) / 3600;
  const hemi = (h1 || h2 || '').toUpperCase();
  if (d.startsWith('-') || hemi === 'S' || hemi === 'W') val = -val;
  return Number(min) >= 60 || Number(sec) >= 60 ? NaN : val;
}

/** "lat lng [alt acc]" or "lat, lng" in one cell — e.g. SurveyCTO/ODK geopoint exports. */
export function parseCombined(v) {
  const parts = String(v ?? '').trim().split(/[\s,;]+/).filter(Boolean);
  if (parts.length < 2) return { lat: NaN, lng: NaN };
  return { lat: parseCoordValue(parts[0]), lng: parseCoordValue(parts[1]) };
}

// ---------------------------------------------------------------- column guessing

const norm = (c) => c.toLowerCase().replace(/[^a-z0-9]/g, '');
const ROLE_NAMES = {
  name: ['name', 'title', 'sitename', 'site', 'placename', 'schoolname', 'school', 'facilityname', 'facility', 'villagename', 'village', 'hhname', 'respondentname', 'label'],
  code: ['code', 'id', 'siteid', 'sitecode', 'ref', 'schoolcode', 'facilitycode', 'uid', 'key'],
  category: ['category', 'type', 'kind', 'sitetype', 'facilitytype'],
  description: ['description', 'desc', 'notes', 'note', 'comments', 'remarks'],
  landmarks: ['landmarks', 'landmark', 'directions', 'howtofind', 'direction'],
  photo: ['photo', 'photourl', 'image', 'imageurl', 'picture'],
};

function findColumn(columns, names) {
  const n = columns.map(norm);
  for (const want of names) { const i = n.indexOf(want); if (i >= 0) return columns[i]; }
  for (const want of names) { const i = n.findIndex((c) => c.endsWith(want) && want.length > 3); if (i >= 0) return columns[i]; }
  return '';
}

function sampleValues(rows, col, n = 50) {
  const out = [];
  for (const r of rows) { const v = r[col]; if (v !== undefined && String(v).trim() !== '') out.push(v); if (out.length >= n) break; }
  return out;
}

/** Best guess of which columns play which role. User can override every choice. */
export function guessMapping(columns, rows) {
  const map = { mode: 'separate', lat: '', lng: '', combined: '', name: '', code: '', category: '', description: '', landmarks: '', photo: '' };
  const n = columns.map(norm);
  const latIdx = n.findIndex((c) => c === 'lat' || c === 'latitude' || c === 'y' || c.endsWith('latitude') || /(^|gps|geo|point)lat$/.test(c));
  const lngIdx = n.findIndex((c) => ['lng', 'lon', 'long', 'longitude', 'x'].includes(c) || c.endsWith('longitude') || /(^|gps|geo|point)(lng|lon|long)$/.test(c));
  if (latIdx >= 0) map.lat = columns[latIdx];
  if (lngIdx >= 0) map.lng = columns[lngIdx];
  if (!map.lat || !map.lng) {
    // Look for a single "lat lng …" column such as a SurveyCTO geopoint.
    const combined = columns.find((c) => {
      const vals = sampleValues(rows, c, 20);
      if (!vals.length) return false;
      const ok = vals.filter((v) => { const p = parseCombined(v); return Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && String(v).trim().split(/[\s,;]+/).length >= 2; });
      return ok.length / vals.length > 0.8 && /gps|geo|loc|coord|point|position/i.test(c);
    });
    if (combined) { map.mode = 'combined'; map.combined = combined; map.lat = ''; map.lng = ''; }
  }
  for (const role of Object.keys(ROLE_NAMES)) map[role] = findColumn(columns, ROLE_NAMES[role]);
  return map;
}

/** Read lat/lng for one row under a mapping. */
export function rowCoords(row, map) {
  if (map.mode === 'combined') return parseCombined(row[map.combined]);
  const lat = parseCoordValue(row[map.lat]);
  const lng = parseCoordValue(row[map.lng]);
  return map.swap ? { lat: lng, lng: lat } : { lat, lng };
}

/**
 * Checks whether the chosen columns really contain GPS coordinates.
 * verdict: 'ok' | 'warn' | 'bad'; messages explain why in plain language.
 */
export function verifyCoordinates(rows, map, { near = null, nearLabel = 'your location' } = {}) {
  const r = { total: rows.length, valid: 0, missing: 0, notNumber: 0, outOfRange: 0, zero: 0, swapHint: 0, latInts: 0, lngInts: 0, numeric: 0, bbox: null, center: null, messages: [], verdict: 'bad', swapSuggested: false, needsColumns: false };
  const hasCols = map.mode === 'combined' ? !!map.combined : !!(map.lat && map.lng);
  if (!hasCols) { r.needsColumns = true; r.messages.push('Choose the column(s) that hold the GPS coordinates.'); return r; }
  if (map.mode !== 'combined' && map.lat === map.lng) { r.needsColumns = true; r.messages.push('Latitude and longitude must be different columns.'); return r; }
  let s = 90, n = -90, w = 180, e = -180, sumLat = 0, sumLng = 0;
  const latSet = new Set();
  for (const row of rows) {
    const rawA = map.mode === 'combined' ? row[map.combined] : row[map.lat];
    const rawB = map.mode === 'combined' ? 'x' : row[map.lng];
    if (rawA == null || String(rawA).trim() === '' || rawB == null || String(rawB).trim() === '') { r.missing++; continue; }
    const { lat, lng } = rowCoords(row, map);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { r.notNumber++; continue; }
    r.numeric++;
    if (!(lat === 0 && lng === 0)) {
      if (Number.isInteger(lat)) r.latInts++;
      if (Number.isInteger(lng)) r.lngInts++;
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      r.outOfRange++;
      // Only a swap if the out-of-range value is a plausible longitude with decimals, not an ID.
      if (Math.abs(lat) > 90 && Math.abs(lat) <= 180 && Math.abs(lng) <= 90 && !Number.isInteger(lat)) r.swapHint++;
      continue;
    }
    if (lat === 0 && lng === 0) { r.zero++; continue; }
    latSet.add(lat);
    r.valid++;
    sumLat += lat; sumLng += lng;
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng);
  }
  if (r.valid) {
    r.bbox = { south: s, north: n, west: w, east: e };
    r.center = { lat: sumLat / r.valid, lng: sumLng / r.valid };
  }

  const pct = (x) => `${Math.round((x / Math.max(1, r.total)) * 100)}%`;
  if (r.missing) r.messages.push(`${r.missing} row(s) have no coordinates and will be skipped.`);
  if (r.notNumber) r.messages.push(`${r.notNumber} row(s) are not numbers (e.g. text) and will be skipped.`);
  if (r.zero) r.messages.push(`${r.zero} row(s) are 0, 0 (usually a failed GPS reading) and will be skipped.`);
  if (r.outOfRange) r.messages.push(`${r.outOfRange} row(s) are outside the valid range (latitude ±90, longitude ±180).`);
  if (r.swapHint && r.swapHint >= r.outOfRange / 2) { r.swapSuggested = true; r.messages.push('Latitude and longitude look swapped — try "Swap".'); }
  // Real GPS readings almost never land on whole degrees; a column of whole numbers is an ID/count.
  const intCol = r.numeric > 1 ? [r.latInts / r.numeric > 0.8 && 'latitude', r.lngInts / r.numeric > 0.8 && 'longitude'].filter(Boolean) : [];
  const looksLikeIds = intCol.length > 0;
  if (looksLikeIds) r.messages.push(`The ${intCol.join(' and ')} column has only whole numbers — these look like IDs or counts, not GPS coordinates.`);
  // Valid-range coordinates can still be swapped (e.g. Kenya's 34.7, -0.08 lands in the
  // Mediterranean). Compare with a known reference point: other places, GPS, or the map.
  let far = false;
  if (near && r.center) {
    const dNow = distance(r.center.lat, r.center.lng, near.lat, near.lng);
    const canSwap = Math.abs(r.center.lng) <= 90;
    const dSwapped = canSwap ? distance(r.center.lng, r.center.lat, near.lat, near.lng) : Infinity;
    if (dNow > 1000000 && dSwapped < dNow / 4 && dSwapped < 1000000) {
      far = true;
      r.swapSuggested = true;
      r.messages.push(`These points are ${Math.round(dNow / 1000).toLocaleString()} km from ${nearLabel}, but only ${Math.round(dSwapped / 1000).toLocaleString()} km if latitude and longitude are swapped — try "Swap".`);
    } else if (dNow > 1500000) {
      far = true;
      r.messages.push(`These points are about ${Math.round(dNow / 1000).toLocaleString()} km from ${nearLabel}. Check the right columns are chosen.`);
    }
  }
  if (r.valid > 3 && latSet.size === 1) r.messages.push('Every row has the same latitude — check you picked the right column.');
  if (r.bbox && (n - s > 30 || e - w > 30)) r.messages.push(`Points are spread over a very large area (${Math.round(n - s)}° × ${Math.round(e - w)}°). Check for wrong or swapped columns.`);

  const bad = r.valid === 0 || looksLikeIds || (r.valid > 3 && latSet.size === 1) || r.valid / Math.max(1, r.total) < 0.5;
  r.verdict = bad ? 'bad' : r.messages.length || far ? 'warn' : 'ok';
  if (r.verdict !== 'bad') r.messages.unshift(`${r.valid} of ${r.total} rows (${pct(r.valid)}) have valid GPS coordinates.`);
  else if (r.valid === 0) r.messages.unshift('None of the rows have usable GPS coordinates in the chosen column(s).');
  else r.messages.unshift(`Only ${r.valid} of ${r.total} rows look like valid GPS coordinates.`);
  return r;
}

const cell = (row, col) => (col ? String(row[col] ?? '').trim() : '');

/** Builds location records. Every original column is kept in `fields` for searching. */
export function applyMapping(rows, map) {
  const locations = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    const { lat, lng } = rowCoords(row, map);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) { skipped++; return; }
    const fields = {};
    for (const [k, v] of Object.entries(row)) {
      const val = String(v ?? '').trim();
      if (val) fields[k] = val.slice(0, 1000);
    }
    locations.push({
      name: cell(row, map.name) || cell(row, map.code) || `Row ${i + 1}`,
      code: cell(row, map.code),
      category: cell(row, map.category),
      description: cell(row, map.description),
      landmarks: cell(row, map.landmarks),
      photoUrl: cell(row, map.photo),
      lat, lng, fields,
    });
  });
  return { locations, skipped };
}

/**
 * Plans a batch update of an existing dataset from a new file.
 * Places are matched by code/ID when both sides have one, otherwise by the same name within 25 m.
 * Returns { updates: [{ existing, incoming }], adds: [incoming], removals: [existing] }.
 */
export function planDatasetUpdate(existingPlaces, incoming) {
  const byCode = new Map();
  for (const e of existingPlaces) if (e.code) byCode.set(String(e.code).trim().toLowerCase(), e);
  const used = new Set();
  const updates = [];
  const adds = [];
  for (const inc of incoming) {
    const code = String(inc.code || '').trim().toLowerCase();
    let match = code ? byCode.get(code) : null;
    if (match && used.has(match.id)) match = null;
    if (!match) {
      match = existingPlaces.find((e) => !used.has(e.id) && e.name === inc.name &&
        (!code || !e.code) && distance(e.lat, e.lng, inc.lat, inc.lng) < 25) || null;
    }
    if (match) { used.add(match.id); updates.push({ existing: match, incoming: inc }); } else adds.push(inc);
  }
  return { updates, adds, removals: existingPlaces.filter((e) => !used.has(e.id)) };
}

/** Indices of the `n` places nearest to (lat, lng), nearest first. O(places) per call. */
export function nearestPlaces(places, lat, lng, n = 3) {
  const best = [];
  for (const p of places) {
    const d = distance(lat, lng, p.lat, p.lng);
    if (best.length < n || d < best[best.length - 1].d) {
      best.push({ place: p, d });
      best.sort((a, b) => a.d - b.d);
      if (best.length > n) best.pop();
    }
  }
  return best;
}

/** One-shot import with automatic column guessing (used for the bundled samples and tests). */
export function parseImport(text, filename = '') {
  const t = readTable(text, filename);
  if (t.kind === 'bundle') return { locations: t.locations, photos: t.photos, skipped: 0 };
  const { locations, skipped } = applyMapping(t.rows, guessMapping(t.columns, t.rows));
  return { locations, photos: [], skipped };
}
