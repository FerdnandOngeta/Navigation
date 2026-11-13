/* global L */
import { db, uid, getSetting, setSetting } from './db.js';
import { network } from './network.js';
import {
  createLayer, PROVIDERS, setCustomProvider, estimateDownload, downloadTiles, cacheAroundPoint,
  tileStats, clearTiles, getTile,
} from './tiles.js';
import { Navigator, trackToGpx } from './nav.js';
import { savePhoto, photosFor, photoUrl, forgetPhotoUrl, photoToExport, photoFromExport, photoFromUrl } from './photos.js';
import {
  distance, bearing, compassLabel, formatDistance, formatDuration, tilesInBounds, corridorTiles,
  parseCoordinates, lngToTileX, latToTileY,
} from './geo.js';
import {
  parseImport, readTable, guessMapping, verifyCoordinates, applyMapping, rowCoords, planDatasetUpdate, nearestPlaces,
} from './importers.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtCoord = (lat, lng) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
/** Thumbnails are interpolated into src/style attributes, so only accept real base64 image data URLs. */
const safeThumb = (t) => (typeof t === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(t) ? t : '');

const DEFAULTS = {
  detail: 'auto', // auto | light | detailed
  baseLayer: 'auto', // auto | streets | topo | satellite | custom
  customTileUrl: '',
  profile: 'car',
  arrivalRadius: 40,
  lastView: null,
  lastOnlineLayer: 'streets',
  showNearby: true,
  nearbyCollapsed: false,
};
const PROFILE_LABELS = { foot: '🚶 Walk', bike: '🚲 Bike', car: '🚙 Vehicle' };

const state = {
  settings: { ...DEFAULTS },
  locations: [],
  datasets: [], // import batches: { id, name, createdAt, updatedAt, columns }
  selectMode: false,
  selected: new Set(),
  layerKey: null,
  baseLayer: null,
  follow: false,
  sheet: null,
  download: null,
  installPrompt: null,
};

const nav = new Navigator();
let map, placesLayer, landmarksLayer, routeLayer, trackLine, straightLine, meMarker, accCircle;

// ---------------------------------------------------------------- utilities

let toastTimer;
function toast(msg, { ms = 3500, html = false, cls = '', onClick } = {}) {
  const el = $('#toast');
  el.className = cls;
  el[html ? 'innerHTML' : 'textContent'] = msg;
  el.hidden = false;
  el.onclick = () => { el.hidden = true; onClick?.(); };
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function download(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

async function saveSettings(patch) {
  Object.assign(state.settings, patch);
  await Promise.all(Object.entries(patch).map(([k, v]) => setSetting(k, v)));
}

async function askPersistentStorage() {
  // Without this, the browser may evict saved maps/photos when the phone is low on space.
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* ignore */ }
}

function myPos() { return nav.position; }
function distFromMe(loc) {
  const p = myPos();
  return p ? distance(p.lat, p.lng, loc.lat, loc.lng) : null;
}

// ---------------------------------------------------------------- map & layers

function resolveLayer() {
  const s = state.settings;
  const q = state.stableQuality ?? network.quality;
  const online = q !== 'offline';
  const detailed = s.detail === 'detailed' ? online : s.detail === 'auto' ? q === 'good' : false;
  let id = s.baseLayer;
  if (id === 'auto') id = detailed ? 'satellite' : online ? 'streets' : s.lastOnlineLayer || 'streets';
  if (!PROVIDERS[id] || PROVIDERS[id].overlay) id = 'streets';
  return { id, detailed };
}

function applyBaseLayer() {
  const { id, detailed } = resolveLayer();
  const key = `${id}:${detailed}`;
  if (key === state.layerKey) return;
  state.layerKey = key;
  if (state.baseLayer) map.removeLayer(state.baseLayer);
  state.baseLayer = createLayer(id, { detailed }).addTo(map);
  if (state.stableQuality !== 'offline' && state.settings.lastOnlineLayer !== id) saveSettings({ lastOnlineLayer: id });
}

const QUALITY_RANK = { offline: 0, poor: 1, fair: 2, good: 3 };
let layerTimer;
/**
 * Hysteresis so a flapping rural connection doesn't swap map styles every few seconds:
 * downgrade only after 30 s of worse signal, upgrade after 8 s of better signal.
 * Going offline applies at once (cached tiles load the same whichever style is chosen).
 */
function scheduleLayerRefresh() {
  const q = network.quality;
  clearTimeout(layerTimer);
  if (q === state.stableQuality) return;
  const delay = q === 'offline' ? 0 : QUALITY_RANK[q] < QUALITY_RANK[state.stableQuality] ? 30000 : 8000;
  layerTimer = setTimeout(() => { state.stableQuality = q; applyBaseLayer(); updatePill(); }, delay);
}

function updatePill() {
  const q = network.quality;
  const pill = $('#net-pill');
  pill.className = `pill ${q}`;
  const { id, detailed } = resolveLayer();
  pill.textContent = { good: 'Good signal', fair: 'Fair signal', poor: 'Weak signal', offline: 'Offline' }[q];
  pill.title = `Map: ${PROVIDERS[id]?.name}${detailed ? ' (detailed)' : ''}`;
}

function initMap() {
  const v = state.settings.lastView;
  map = L.map('map', { zoomControl: false, worldCopyJump: true, maxZoom: 21, minZoom: 2, attributionControl: true })
    .setView(v ? [v.lat, v.lng] : [0.2, 36.5], v ? v.zoom : 6);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  const labels = map.createPane('labels');
  labels.style.zIndex = 250;
  labels.style.pointerEvents = 'none';

  routeLayer = L.layerGroup().addTo(map);
  trackLine = L.polyline([], { color: '#7b2cbf', weight: 4, opacity: 0.8 }).addTo(map);
  straightLine = L.polyline([], { color: '#e76f24', weight: 4, dashArray: '8 10' }).addTo(map);
  landmarksLayer = L.layerGroup().addTo(map);
  placesLayer = L.layerGroup().addTo(map);

  let viewTimer;
  map.on('moveend', () => {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      const c = map.getCenter();
      saveSettings({ lastView: { lat: c.lat, lng: c.lng, zoom: map.getZoom() } });
    }, 1500);
  });
  map.on('dragstart', () => setFollow(false));
  map.on('click', (e) => {
    hideResults();
    if (state.picking) {
      const { loc, profile } = state.picking;
      state.picking = null;
      $('#toast').hidden = true;
      state.pendingFrom = { id: null, name: 'Point picked on map', lat: e.latlng.lat, lng: e.latlng.lng };
      state.lastFromChoice = 'pin';
      startNavigation(loc, profile, state.pendingFrom);
      return;
    }
    showPinPopup(e.latlng.lat, e.latlng.lng, 'Dropped pin');
  });
  applyBaseLayer();
}

function showPinPopup(lat, lng, title) {
  const d = distFromMe({ lat, lng });
  const el = document.createElement('div');
  el.innerHTML = `<b>${esc(title)}</b><br><span class="small-text">${fmtCoord(lat, lng)}</span>
    ${d != null ? `<br><span class="small-text">${formatDistance(d)} ${compassLabel(bearing(myPos().lat, myPos().lng, lat, lng))} of you</span>` : ''}
    <div class="popup-actions"><button class="btn primary" data-a="nav">Navigate</button><button class="btn" data-a="save">Save place</button></div>
    <div class="popup-actions"><button class="btn" data-a="from">Start trip from here</button></div>`;
  const popup = L.popup({ closeButton: true }).setLatLng([lat, lng]).setContent(el).openOn(map);
  $('[data-a=from]', el).onclick = () => {
    map.closePopup(popup);
    state.pendingFrom = { id: null, name: title === 'Dropped pin' ? 'Dropped pin' : title, lat, lng };
    state.lastFromChoice = 'pin';
    toast('Start point set. Now open a destination and tap Navigate.', { ms: 5000 });
  };
  $('[data-a=nav]', el).onclick = () => { map.closePopup(popup); startNavigation({ id: null, name: title, lat, lng }); };
  $('[data-a=save]', el).onclick = () => { map.closePopup(popup); renderForm(null, { lat, lng, name: title === 'Dropped pin' ? '' : title }); };
}

// ---------------------------------------------------------------- places on the map

function pinIcon(loc) {
  const isTarget = nav.target && nav.target.id === loc.id;
  const cls = ['pin', loc.thumb ? 'photo' : '', loc.visited ? 'visited' : '', isTarget ? 'target' : ''].join(' ');
  const style = loc.thumb ? `background-image:url('${loc.thumb}')` : '';
  return L.divIcon({
    className: '', iconSize: [38, 38], iconAnchor: [19, 46], popupAnchor: [0, -40],
    html: `<div class="${cls}" style="${style}"><span>${esc((loc.name || '?').replace(/^Sample:\s*/, '')[0])}</span></div>`,
  });
}

function renderPlaceMarkers() {
  placesLayer.clearLayers();
  for (const loc of state.locations) {
    L.marker([loc.lat, loc.lng], { icon: pinIcon(loc), title: loc.name, zIndexOffset: nav.target?.id === loc.id ? 1000 : 0 })
      .on('click', () => openPlace(loc))
      .addTo(placesLayer);
  }
}

async function loadLocations() {
  state.locations = (await db.all('locations')).sort((a, b) => a.name.localeCompare(b.name));
  state.datasets = (await db.all('datasets')).sort((a, b) => b.updatedAt - a.updatedAt);
  searchIndex = new Map();
  renderPlaceMarkers();
  updateNearby(true);
}

// ---------------------------------------------------------------- search

function hideResults() { $('#search-results').hidden = true; }

// ---- search across every column of the imported dataset ----
const BUILTIN_COLUMNS = { name: 'Name', code: 'Code', category: 'Category', landmarks: 'Directions', description: 'Notes' };
let searchIndex = new Map(); // location id -> [[keyLower, label, valueLower, value], …]

function indexEntries(l) {
  let e = searchIndex.get(l.id);
  if (!e) {
    e = [];
    for (const [k, label] of Object.entries(BUILTIN_COLUMNS)) if (l[k]) e.push([k, label, String(l[k]).toLowerCase(), String(l[k])]);
    for (const [k, v] of Object.entries(l.fields || {})) e.push([k.toLowerCase(), k, String(v).toLowerCase(), String(v)]);
    searchIndex.set(l.id, e);
  }
  return e;
}

/** Column names available to search: built-ins plus every column seen in imported data. */
function searchableColumns() {
  const set = new Set();
  state.locations.forEach((l) => Object.keys(l.fields || {}).forEach((k) => set.add(k)));
  // Skip data columns that just repeat a built-in one (e.g. "name"), which is listed already.
  return [...set].filter((k) => !(k.toLowerCase() in BUILTIN_COLUMNS)).sort((a, b) => a.localeCompare(b));
}

/**
 * Every word must match some column. "column:value" (e.g. district:kisumu, or
 * ward:"kolwa east") restricts that word to columns whose name contains "column".
 * `column` restricts all words to one column. Returns [{ loc, match: { label, value } | null }].
 */
function searchPlaces(q, { column = '', limit = 40 } = {}) {
  const tokens = [...q.matchAll(/(\S+?:"[^"]*"|"[^"]*"|\S+)/g)].map((m) => m[0]);
  if (!tokens.length) return [];
  const terms = tokens.map((t) => {
    const m = t.match(/^([^:"]+):(.+)$/);
    const strip = (s) => s.replace(/^"|"$/g, '').toLowerCase();
    return m ? { key: m[1].toLowerCase(), val: strip(m[2]) } : { key: null, val: strip(t) };
  }).filter((t) => t.val);
  const col = column.toLowerCase();
  const out = [];
  for (const l of state.locations) {
    const entries = indexEntries(l);
    let match = null;
    const ok = terms.every((t) => {
      const hit = entries.find(([k, , v]) => v.includes(t.val) && (col ? k === col : t.key ? k.includes(t.key) : true));
      if (hit && !match && hit[0] !== 'name') match = { label: hit[1], value: hit[3] };
      return !!hit;
    });
    if (ok) out.push({ loc: l, match });
  }
  const p = myPos();
  if (p) out.sort((a, b) => distFromMe(a.loc) - distFromMe(b.loc));
  return limit ? out.slice(0, limit) : out;
}

const localMatches = (q) => searchPlaces(q).map((r) => r.loc);

function matchHtml(match) {
  return match ? `<div class="match">${esc(match.label)}: ${esc(match.value.length > 40 ? `${match.value.slice(0, 40)}…` : match.value)}</div>` : '';
}

let geocodeCtrl;
async function renderSearch(q, includeOnline) {
  const box = $('#search-results');
  q = q.trim();
  if (!q) { hideResults(); return; }
  box.hidden = false;
  const parts = [];
  const coords = parseCoordinates(q);
  if (coords) parts.push(`<button data-coords="${coords.lat},${coords.lng}"><span class="thumb">⌖</span><div>Go to ${fmtCoord(coords.lat, coords.lng)}</div></button>`);
  for (const { loc: l, match } of searchPlaces(q)) {
    const d = distFromMe(l);
    parts.push(`<button data-id="${esc(l.id)}">${l.thumb ? `<img class="thumb" src="${l.thumb}" alt="">` : '<span class="thumb">📍</span>'}
      <div style="min-width:0"><div><b>${esc(l.name)}</b></div><div class="muted">${esc(l.category || '')}${l.code ? ` · ${esc(l.code)}` : ''}</div>${matchHtml(match)}</div>
      <span class="tag">${d != null ? formatDistance(d) : 'Saved'}</span></button>`);
  }
  if (!network.online) parts.push('<div class="hint">Offline — only your saved places are searchable.</div>');
  else if (!includeOnline) parts.push('<div class="hint">Press Enter / Search to also look up addresses online.</div>');
  else parts.push('<div class="hint" id="geo-hint">Searching the map online…</div>');
  box.innerHTML = parts.join('') || '<div class="hint">No saved places match.</div>';
  bindResultClicks(box);

  if (includeOnline && network.online && !coords) {
    geocodeCtrl?.abort();
    geocodeCtrl = new AbortController();
    try {
      const b = map.getBounds();
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
      const res = await fetch(url, { signal: geocodeCtrl.signal, headers: { Accept: 'application/json' } });
      const data = await res.json();
      const hint = $('#geo-hint');
      if (!hint) return;
      hint.outerHTML = data.length
        ? data.map((r) => `<button data-geo="${Number(r.lat)},${Number(r.lon)}"data-name="${esc(r.name || r.display_name.split(',')[0])}"><span class="thumb">🗺</span>
            <div><div><b>${esc(r.name || r.display_name.split(',')[0])}</b></div><div class="muted">${esc(r.display_name)}</div></div><span class="tag">Map</span></button>`).join('')
        : '<div class="hint">No online results.</div>';
      bindResultClicks(box);
    } catch (e) {
      if (e.name !== 'AbortError') { const h = $('#geo-hint'); if (h) h.textContent = 'Online search failed — weak connection?'; }
    }
  }
}

function bindResultClicks(box) {
  $$('button', box).forEach((btn) => {
    btn.onclick = () => {
      hideResults();
      $('#search').blur();
      if (btn.dataset.id) {
        const loc = state.locations.find((l) => l.id === btn.dataset.id);
        if (loc) openPlace(loc);
      } else {
        const [lat, lng] = (btn.dataset.coords || btn.dataset.geo).split(',').map(Number);
        map.setView([lat, lng], Math.max(map.getZoom(), 15));
        showPinPopup(lat, lng, btn.dataset.name || 'Coordinates');
      }
    };
  });
}

// ---------------------------------------------------------------- bottom sheet

function openSheet(title, html, tab = null) {
  clearImportPreview();
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').scrollTop = 0;
  $('#sheet').hidden = false;
  document.body.classList.add('sheet-open');
  state.sheet = tab;
  $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  return $('#sheet-body');
}

function closeSheet() {
  clearImportPreview();
  $('#sheet').hidden = true;
  document.body.classList.remove('sheet-open');
  state.sheet = null;
  $$('#tabbar button').forEach((b) => b.classList.remove('active'));
}

function seg(name, options, current) {
  return `<div class="seg" data-seg="${name}">${Object.entries(options)
    .map(([v, label]) => `<button type="button" data-v="${v}" class="${v === String(current) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}
function bindSeg(root, name, onPick) {
  const el = $(`[data-seg="${name}"]`, root);
  $$('button', el).forEach((b) => {
    b.onclick = () => {
      $$('button', el).forEach((x) => x.classList.toggle('on', x === b));
      onPick(b.dataset.v);
    };
  });
}

// ---------------------------------------------------------------- places list

const PLACES_SHOWN = 300;
const NO_DATASET = '__none__';
const datasetCount = (id) => state.locations.filter((l) => (l.datasetId || NO_DATASET) === id).length;

/** All places matching the Places tab's current search, column and dataset filters. */
function placesTabResults() {
  const filter = state.placesFilter || '';
  const column = state.placesColumn || '';
  const ds = state.placesDataset || '';
  let results = filter.trim() ? searchPlaces(filter, { column, limit: 0 }) : state.locations.map((loc) => ({ loc, match: null }));
  if (ds) results = results.filter((r) => (r.loc.datasetId || NO_DATASET) === ds);
  if (myPos() && !filter.trim()) results.sort((a, b) => distFromMe(a.loc) - distFromMe(b.loc));
  return results;
}

function renderPlaces(filter = state.placesFilter ?? '', column = state.placesColumn ?? '') {
  state.placesFilter = filter;
  state.placesColumn = column;
  // Drop selections for places that no longer exist.
  const ids = new Set(state.locations.map((l) => l.id));
  state.selected.forEach((id) => { if (!ids.has(id)) state.selected.delete(id); });
  const p = myPos();
  const all = placesTabResults();
  const total = all.length;
  const results = all.slice(0, PLACES_SHOWN);
  const cols = searchableColumns();
  const ds = state.placesDataset || '';
  const orphans = datasetCount(NO_DATASET);
  const sel = state.selectMode;
  const body = openSheet(`Places (${state.locations.length})`, `
    ${state.locations.length ? `
      <div class="grid2" style="grid-template-columns: 2fr 1fr">
        <label class="field"><input id="pl-filter" type="search" placeholder="Search any column…" value="${esc(filter)}"></label>
        <label class="field"><select id="pl-col" title="Search in">
          <option value="">All columns</option>
          ${Object.entries(BUILTIN_COLUMNS).map(([k, label]) => `<option value="${k}" ${k === column ? 'selected' : ''}>${label}</option>`).join('')}
          ${cols.length ? `<optgroup label="Columns from your data">${cols.map((c) => `<option value="${esc(c)}" ${c === column ? 'selected' : ''}>${esc(c)}</option>`).join('')}</optgroup>` : ''}
        </select></label>
      </div>
      ${state.datasets.length ? `<label class="field"><select id="pl-ds" title="Dataset">
        <option value="">All datasets</option>
        ${state.datasets.map((d) => `<option value="${esc(d.id)}" ${d.id === ds ? 'selected' : ''}>${esc(d.name)} (${datasetCount(d.id)})</option>`).join('')}
        ${orphans ? `<option value="${NO_DATASET}" ${ds === NO_DATASET ? 'selected' : ''}>Added by hand / older imports (${orphans})</option>` : ''}
      </select></label>` : ''}
      ${filter.trim() || ds ? `<p class="muted small-text">${total.toLocaleString()} match${total === 1 ? '' : 'es'}${total > PLACES_SHOWN ? ` (showing first ${PLACES_SHOWN})` : ''}</p>` : ''}` : `
      <div class="notice">No places yet. Import your site list (CSV, GeoJSON or a file exported from this app), add places by tapping the map, or load the samples to try things out.</div>`}
    <div class="row">
      <button class="btn small" id="pl-import">⬆ Import</button>
      <button class="btn small" id="pl-export" ${state.locations.length ? '' : 'disabled'}>⬇ Export</button>
      ${state.locations.length ? `<button class="btn small ${sel ? 'primary' : ''}" id="pl-select">☑ ${sel ? 'Done' : 'Select'}</button>` : '<button class="btn small" id="pl-sample">Load samples</button>'}
    </div>
    ${sel ? `<div class="bulk-bar">
      <div class="row" style="margin:0;align-items:center">
        <b id="bulk-count">${state.selected.size} selected</b>
        <button class="btn small" id="bulk-all">Select all ${total.toLocaleString()}${filter.trim() || ds ? ' matching' : ''}</button>
        <button class="btn small ghost" id="bulk-none">Clear</button>
      </div>
      <div class="row" style="margin:6px 0 0">
        <button class="btn small" data-bulk="visited">✓ Visited</button>
        <button class="btn small" data-bulk="unvisited">↺ Not visited</button>
        <button class="btn small" data-bulk="category">🏷 Category</button>
        <button class="btn small" data-bulk="offline">⬇ Offline maps</button>
        <button class="btn small danger" data-bulk="delete">🗑 Delete</button>
      </div></div>` : ''}
    <div id="pl-list">${results.map(({ loc: l, match }) => {
      const d = distFromMe(l);
      const checked = state.selected.has(l.id);
      return `<button class="place ${checked ? 'selected' : ''}" data-id="${esc(l.id)}">
        ${sel ? `<span class="check-box">${checked ? '☑' : '☐'}</span>` : ''}
        ${l.thumb ? `<img class="thumb" src="${l.thumb}" alt="">` : '<span class="thumb">📍</span>'}
        <div class="meta"><div class="name">${esc(l.name)}</div>
          <div class="muted">${esc(l.category || 'Uncategorised')}${l.visited ? ' · <span class="badge">Visited</span>' : ''}</div>${matchHtml(match)}</div>
        <div class="dist">${d != null ? `${formatDistance(d)}<br>${compassLabel(bearing(p.lat, p.lng, l.lat, l.lng))}` : ''}</div></button>`;
    }).join('')}</div>
    ${state.datasets.length ? `<div class="section-title">Datasets (import batches)</div>
      ${state.datasets.map((d) => `<div class="card dataset">
        <div><b>${esc(d.name)}</b> · ${datasetCount(d.id)} places</div>
        <div class="muted small-text">Imported ${new Date(d.createdAt).toLocaleDateString()}${d.updatedAt !== d.createdAt ? ` · updated ${new Date(d.updatedAt).toLocaleString()}` : ''}</div>
        <div class="row" style="margin:6px 0 0">
          <button class="btn small" data-ds-update="${esc(d.id)}">⟳ Update from new file</button>
          <button class="btn small" data-ds-show="${esc(d.id)}">Show only</button>
          <button class="btn small ghost" data-ds-delete="${esc(d.id)}" style="color:var(--red)">Delete dataset</button>
        </div></div>`).join('')}` : ''}
    <p class="muted small-text">Search matches every column in your data. Tip: <b>district:kisumu</b> searches just the "district" column; use quotes for spaces, e.g. <b>ward:"kolwa east"</b>.</p>`, 'places');

  const f = $('#pl-filter', body);
  if (f) {
    let t;
    f.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const caret = f.selectionStart;
        renderPlaces(f.value, $('#pl-col').value);
        const nf = $('#pl-filter');
        nf.focus();
        nf.setSelectionRange(caret, caret);
      }, 150);
    };
    $('#pl-col', body).onchange = (e) => renderPlaces(f.value, e.target.value);
  }
  const dsSel = $('#pl-ds', body);
  if (dsSel) dsSel.onchange = (e) => { state.placesDataset = e.target.value; renderPlaces(); };
  $('#pl-import', body).onclick = () => $('#file-import').click();
  $('#pl-export', body).onclick = () => renderExport();
  const sample = $('#pl-sample', body);
  if (sample) sample.onclick = loadSamples;
  const selBtn = $('#pl-select', body);
  if (selBtn) selBtn.onclick = () => { state.selectMode = !state.selectMode; if (!state.selectMode) state.selected.clear(); renderPlaces(); };

  $$('.place', body).forEach((b) => {
    b.onclick = () => {
      if (!state.selectMode) { openPlace(state.locations.find((l) => l.id === b.dataset.id)); return; }
      // Toggle in place (no re-render) so the list doesn't jump while ticking many rows.
      const id = b.dataset.id;
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      const on = state.selected.has(id);
      b.classList.toggle('selected', on);
      $('.check-box', b).textContent = on ? '☑' : '☐';
      $('#bulk-count').textContent = `${state.selected.size} selected`;
    };
  });
  if (sel) {
    $('#bulk-all', body).onclick = () => { all.forEach((r) => state.selected.add(r.loc.id)); renderPlaces(); };
    $('#bulk-none', body).onclick = () => { state.selected.clear(); renderPlaces(); };
    $$('[data-bulk]', body).forEach((b) => { b.onclick = () => bulkAction(b.dataset.bulk); });
  }
  $$('[data-ds-update]', body).forEach((b) => {
    b.onclick = () => { state.updateTarget = b.dataset.dsUpdate; $('#file-import').click(); };
  });
  $$('[data-ds-show]', body).forEach((b) => {
    b.onclick = () => {
      state.placesDataset = b.dataset.dsShow;
      const pts = state.locations.filter((l) => l.datasetId === b.dataset.dsShow).map((l) => [l.lat, l.lng]);
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 15 });
      renderPlaces();
    };
  });
  $$('[data-ds-delete]', body).forEach((b) => { b.onclick = () => deleteDataset(b.dataset.dsDelete); });
}

/** Applies one action to every selected place in a single batch. */
async function bulkAction(action) {
  const chosen = state.locations.filter((l) => state.selected.has(l.id));
  if (!chosen.length) { toast('Select some places first (or tap "Select all")'); return; }
  const n = chosen.length;
  const now = Date.now();
  if (action === 'visited' || action === 'unvisited') {
    const visited = action === 'visited';
    await db.putMany('locations', chosen.map((l) => ({ ...l, visited, visitedAt: visited ? (l.visitedAt || now) : undefined, updatedAt: now })));
    toast(`${n} place${n === 1 ? '' : 's'} marked ${visited ? 'visited' : 'not visited'}`);
  } else if (action === 'category') {
    const existing = [...new Set(state.locations.map((l) => l.category).filter(Boolean))].slice(0, 8).join(', ');
    const cat = prompt(`New category for ${n} place(s)${existing ? `\nExisting: ${existing}` : ''}`);
    if (cat === null) return;
    await db.putMany('locations', chosen.map((l) => ({ ...l, category: cat.trim(), updatedAt: now })));
    toast(`Category set on ${n} place${n === 1 ? '' : 's'}`);
  } else if (action === 'offline') {
    if (!network.online) { toast('Connect to the internet to download offline maps'); return; }
    const tiles = new Map();
    for (const l of chosen.slice(0, 500)) {
      for (const t of tilesInBounds({ south: l.lat - 0.003, north: l.lat + 0.003, west: l.lng - 0.003, east: l.lng + 0.003 }, 14, 17)) tiles.set(`${t.z}/${t.x}/${t.y}`, t);
    }
    const lats = chosen.map((l) => l.lat), lngs = chosen.map((l) => l.lng);
    runDownload(`Saving maps around ${n} places`, 'satellite', [...tiles.values()], {
      name: `Around ${n} selected places`, zMin: 14, zMax: 17,
      bounds: { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) },
    });
    return;
  } else if (action === 'delete') {
    const withPhotos = chosen.filter((l) => l.thumb).length;
    if (!confirm(`Delete ${n} place(s)${withPhotos ? `, ${withPhotos} with photos,` : ''} from this phone? This cannot be undone. Export first if you need a copy.`)) return;
    if (nav.target && state.selected.has(nav.target.id)) stopNavigation();
    const res = await deletePlaces(chosen);
    state.selected.clear();
    toast(`Deleted ${res.places} place${res.places === 1 ? '' : 's'} and ${res.photos} photo${res.photos === 1 ? '' : 's'}`);
  }
  await loadLocations();
  renderPlaces();
}

async function deleteDataset(id) {
  const ds = state.datasets.find((d) => d.id === id);
  const places = state.locations.filter((l) => l.datasetId === id);
  const withPhotos = places.filter((l) => l.thumb).length;
  if (!confirm(`Delete the dataset "${ds?.name}" and its ${places.length} place(s)${withPhotos ? ` (${withPhotos} with photos)` : ''} from this phone? This cannot be undone.`)) return;
  if (nav.target && places.some((l) => l.id === nav.target.id)) stopNavigation();
  const res = await deletePlaces(places);
  await db.del('datasets', id);
  if (state.placesDataset === id) state.placesDataset = '';
  await loadLocations();
  toast(`Deleted dataset "${ds?.name}" (${res.places} places)`);
  renderPlaces();
}

function renderExport() {
  const body = openSheet('Export places', `
    <p>Share your place list with colleagues. They import the file in their own app.</p>
    <button class="btn primary block" id="ex-full">Export with photos</button>
    <p class="muted small-text">Larger file. Best over Wi-Fi or by USB/Bluetooth transfer.</p>
    <button class="btn block" id="ex-lite">Export list only (small file)</button>
    <p class="muted small-text">No photos. Easy to send over WhatsApp/SMS-grade connections.</p>
    <button class="btn block ghost" id="ex-csv">Export as CSV (spreadsheet)</button>`, 'places');
  $('#ex-full', body).onclick = () => exportPlaces(true);
  $('#ex-lite', body).onclick = () => exportPlaces(false);
  $('#ex-csv', body).onclick = () => {
    const core = ['name', 'latitude', 'longitude', 'category', 'code', 'description', 'landmarks', 'visited'];
    // Original dataset columns are exported too, so the CSV can be joined back to the source data.
    const extra = searchableColumns().filter((c) => !core.includes(c.toLowerCase()));
    const cols = [...core, ...extra];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = state.locations.map((l) => [l.name, l.lat, l.lng, l.category, l.code, l.description, l.landmarks, l.visited ? 'yes' : '',
      ...extra.map((c) => l.fields?.[c])].map(q).join(','));
    download(`places-${new Date().toISOString().slice(0, 10)}.csv`, new Blob([[cols.join(','), ...rows].join('\n')], { type: 'text/csv' }));
  };
}

async function exportPlaces(withPhotos) {
  toast('Preparing export…');
  const photos = withPhotos ? await Promise.all((await db.all('photos')).map(photoToExport)) : [];
  const locations = withPhotos ? state.locations : state.locations.map(({ thumb, ...rest }) => rest);
  const bundle = { app: 'field-navigator', version: 1, exportedAt: new Date().toISOString(), datasets: state.datasets, locations, photos };
  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
  const name = `places-${withPhotos ? 'full' : 'lite'}-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Field Navigator places' }); return; } catch { /* fall back to download */ }
  }
  download(name, blob);
  toast(`Exported ${locations.length} places (${(blob.size / 1048576).toFixed(1)} MB)`);
}

/** Entry point for a picked file: app bundles import directly, tables go through column review. */
async function importText(text, filename) {
  let table;
  try { table = readTable(text, filename); } catch (e) { toast(`Could not read file: ${e.message}`); return; }
  if (table.kind === 'bundle') { await saveImported({ locations: table.locations, photos: table.photos, datasets: table.datasets, skipped: 0 }, { mode: 'bundle' }); return; }
  if (!table.rows.length) { toast('The file has no data rows'); return; }
  $('#toast').hidden = true;
  renderImportMapping(table, filename);
}

let previewLayer;
function clearImportPreview() {
  previewLayer?.clearLayers();
  document.body.classList.remove('peek');
}

/**
 * Lets the user confirm or choose which columns hold the GPS coordinates (and name, code…),
 * and shows live checks that the chosen values really are coordinates before importing.
 */
async function renderImportMapping(table, filename) {
  const { columns, rows } = table;
  const mappingKey = `mapping:${columns.join('|')}`.slice(0, 1000);
  const remembered = await getSetting(mappingKey, null);
  const usable = remembered && Object.entries(remembered).every(([k, v]) => k === 'mode' || !v || columns.includes(v));
  const m = usable ? { ...remembered } : guessMapping(columns, rows);
  const example = (c) => {
    const r = rows.find((x) => String(x[c] ?? '').trim());
    const v = r ? String(r[c]).trim() : '';
    return v.length > 22 ? `${v.slice(0, 22)}…` : v;
  };
  const options = (selected, placeholder) => `<option value="">${placeholder}</option>${columns.map((c) => {
    const ex = example(c);
    return `<option value="${esc(c)}" ${c === selected ? 'selected' : ''}>${esc(c)}${ex ? ` — e.g. ${esc(ex)}` : ''}</option>`;
  }).join('')}`;
  const roleSelect = (role, label) => `<label class="field">${label}<select data-role="${role}">${options(m[role], '— none —')}</select></label>`;
  // Default to updating: the dataset picked via "Update from file", else one with the same columns.
  const sameLayout = state.datasets.find((d) => (d.columns || []).join('|') === columns.join('|'));
  const target = state.updateTarget || sameLayout?.id;
  state.updateTarget = null;
  const dsDefault = { mode: target ? 'update' : 'new', target: target || state.datasets[0]?.id };
  let dsMode = dsDefault.mode;

  const body = openSheet('Check your data', `
    <p class="muted">${rows.length.toLocaleString()} rows · ${columns.length} columns in <b>${esc(filename)}</b>.
      ${usable ? 'Using the columns you chose last time for this file layout.' : ''}</p>
    <div class="section-title">Where are the GPS coordinates?</div>
    ${seg('cmode', { separate: 'Two columns (lat + lng)', combined: 'One column ("lat lng")' }, m.mode)}
    <div id="im-sep">
      <div class="grid2">
        <label class="field">Latitude (N/S)<select id="im-lat">${options(m.lat, '— choose column —')}</select></label>
        <label class="field">Longitude (E/W)<select id="im-lng">${options(m.lng, '— choose column —')}</select></label>
      </div>
      <button type="button" class="btn small" id="im-swap">⇄ Swap latitude / longitude</button>
    </div>
    <div id="im-comb"><label class="field">GPS column (e.g. SurveyCTO geopoint)<select id="im-comb-col">${options(m.combined, '— choose column —')}</select></label></div>
    <div id="im-verdict" class="notice"></div>
    <div id="im-sample"></div>
    <div class="row"><button type="button" class="btn small" id="im-preview">👁 Preview points on map</button></div>

    <div class="section-title">Other columns (optional)</div>
    <div class="grid2">${roleSelect('name', 'Place name')}${roleSelect('code', 'Code / ID')}</div>
    <div class="grid2">${roleSelect('category', 'Category')}${roleSelect('landmarks', 'Directions / landmarks')}</div>
    <div class="grid2">${roleSelect('description', 'Notes')}${roleSelect('photo', 'Photo URL')}</div>
    <p class="muted small-text">Every column in the file is kept with each place and can be searched, whatever you choose here.</p>

    <div class="section-title">Save as</div>
    ${state.datasets.length ? seg('dsmode', { new: 'New dataset', update: 'Update an existing dataset' }, dsDefault.mode) : ''}
    <div id="ds-new"><label class="field">Dataset name<input id="ds-name" value="${esc(filename.replace(/\.[^.]+$/, ''))}"></label></div>
    <div id="ds-upd">
      <label class="field">Dataset to update<select id="ds-target">${state.datasets.map((d) => `<option value="${esc(d.id)}" ${d.id === dsDefault.target ? 'selected' : ''}>${esc(d.name)} (${datasetCount(d.id)} places)</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="ds-remove" checked> Remove places that are no longer in this file</label>
      <div id="ds-plan" class="notice small-text"></div>
    </div>
    <div class="row"><button type="button" class="btn primary block" id="im-go">Import</button></div>
    <div class="row"><button type="button" class="btn ghost block" id="im-cancel">Cancel</button></div>`, 'places');

  const latSel = $('#im-lat', body), lngSel = $('#im-lng', body), combSel = $('#im-comb-col', body);
  let report;
  // Reference point for the "are these in the right part of the world?" check.
  let ref = {};
  if (state.locations.length) {
    const n = state.locations.length;
    ref = { near: { lat: state.locations.reduce((s, l) => s + l.lat, 0) / n, lng: state.locations.reduce((s, l) => s + l.lng, 0) / n }, nearLabel: 'your other saved places' };
  } else if (myPos()) ref = { near: myPos(), nearLabel: 'your GPS location' };
  else if (state.settings.lastView) ref = { near: state.settings.lastView, nearLabel: 'the area on your map' };
  const refresh = () => {
    m.lat = latSel.value; m.lng = lngSel.value; m.combined = combSel.value; m.swap = false;
    $$('[data-role]', body).forEach((s) => { m[s.dataset.role] = s.value; });
    $('#im-sep', body).hidden = m.mode !== 'separate';
    $('#im-comb', body).hidden = m.mode !== 'combined';
    report = verifyCoordinates(rows, m, ref);
    $('#im-swap', body).classList.toggle('primary', report.swapSuggested);
    const box = $('#im-verdict', body);
    box.className = `notice ${report.verdict === 'ok' ? '' : report.verdict === 'warn' || report.needsColumns ? 'warn' : 'bad'}`;
    const heading = report.needsColumns ? '➜ Choose the GPS column(s) above'
      : report.verdict === 'ok' ? '✓ These look like GPS coordinates'
        : report.verdict === 'warn' ? '⚠ GPS coordinates found — please check the notes' : '✕ These do not look like GPS coordinates';
    box.innerHTML = `<b>${heading}</b>
      <ul class="small-text">${report.messages.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${report.bbox ? `<div class="small-text">Area covered: ${report.bbox.south.toFixed(3)} to ${report.bbox.north.toFixed(3)} lat, ${report.bbox.west.toFixed(3)} to ${report.bbox.east.toFixed(3)} lng.</div>` : ''}`;
    const sample = rows.slice(0, 5).map((r, i) => {
      const { lat, lng } = rowCoords(r, m);
      const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
      const name = (m.name && r[m.name]) || (m.code && r[m.code]) || `Row ${i + 1}`;
      return `<tr><td>${esc(String(name).slice(0, 30))}</td><td>${Number.isFinite(lat) ? lat.toFixed(5) : '–'}</td><td>${Number.isFinite(lng) ? lng.toFixed(5) : '–'}</td><td>${ok ? '✓' : '✕'}</td></tr>`;
    }).join('');
    $('#im-sample', body).innerHTML = `<table class="sample"><tr><th>First rows</th><th>Lat</th><th>Lng</th><th></th></tr>${sample}</table>`;
    const go = $('#im-go', body);
    go.disabled = report.valid === 0;
    $('#ds-new', body).hidden = dsMode !== 'new';
    $('#ds-upd', body).hidden = dsMode !== 'update';
    if (dsMode === 'update' && report.valid) {
      // Preview the batch: what will be updated, added and removed.
      const incoming = applyMapping(rows, m).locations;
      const dsId = $('#ds-target', body).value;
      plan = planDatasetUpdate(state.locations.filter((l) => (l.datasetId || '') === dsId), incoming);
      const remove = $('#ds-remove', body).checked;
      const withWork = plan.removals.filter((l) => l.thumb || l.visited).length;
      $('#ds-plan', body).className = `notice small-text ${remove && plan.removals.length ? 'warn' : ''}`;
      $('#ds-plan', body).innerHTML = `<b>${plan.updates.length}</b> will be updated · <b>${plan.adds.length}</b> added · <b>${remove ? plan.removals.length : 0}</b> removed${!remove && plan.removals.length ? ` (${plan.removals.length} not in the file will be kept)` : ''}.
        ${remove && withWork ? `<br>${withWork} of the removed places have photos or are marked visited.` : ''}
        <br><span class="muted">Matched by ${m.code ? `the “${esc(m.code)}” column` : 'name and location (choose a Code / ID column for more reliable matching)'}. Photos and visited status of updated places are kept.</span>`;
      go.textContent = `Update dataset (${plan.updates.length} updated, ${plan.adds.length} new${remove ? `, ${plan.removals.length} removed` : ''})`;
    } else {
      plan = null;
      go.textContent = report.verdict === 'bad' && report.valid ? `Import ${report.valid} anyway` : `Import ${report.valid.toLocaleString()} place${report.valid === 1 ? '' : 's'}`;
    }
    if (previewLayer?.getLayers().length) drawPreview();
  };
  let plan = null;
  const drawPreview = () => {
    previewLayer ??= L.layerGroup().addTo(map);
    previewLayer.clearLayers();
    const pts = [];
    for (const r of rows) {
      const { lat, lng } = rowCoords(r, m);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) continue;
      pts.push([lat, lng]);
      if (pts.length <= 3000) {
        L.circleMarker([lat, lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#e76f24', fillOpacity: 0.9 })
          .bindTooltip(esc(String((m.name && r[m.name]) || '')))
          .addTo(previewLayer);
      }
    }
    if (pts.length) {
      document.body.classList.add('peek');
      map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15, paddingBottomRight: [0, $('#sheet').offsetHeight] });
    }
  };

  bindSeg(body, 'cmode', (v) => { m.mode = v; refresh(); });
  if (state.datasets.length) bindSeg(body, 'dsmode', (v) => { dsMode = v; refresh(); });
  [latSel, lngSel, combSel, $('#ds-target', body), $('#ds-remove', body), ...$$('[data-role]', body)].forEach((s) => { s.onchange = refresh; });
  $('#im-swap', body).onclick = () => { const a = latSel.value; latSel.value = lngSel.value; lngSel.value = a; refresh(); };
  $('#im-preview', body).onclick = drawPreview;
  $('#im-cancel', body).onclick = () => { clearImportPreview(); closeSheet(); };
  $('#im-go', body).onclick = async () => {
    if (report.verdict === 'bad' && !confirm('The checks say these may not be GPS coordinates. Import anyway?')) return;
    const removeMissing = dsMode === 'update' && $('#ds-remove', body).checked;
    if (removeMissing && plan?.removals.length) {
      const withPhotos = plan.removals.filter((l) => l.thumb).length;
      const names = plan.removals.slice(0, 5).map((l) => `• ${l.name}`).join('\n');
      if (!confirm(`${plan.removals.length} place(s) are not in the new file and will be deleted from this phone${withPhotos ? `, including ${withPhotos} with photos` : ''}. This cannot be undone.\n\n${names}${plan.removals.length > 5 ? '\n…' : ''}\n\nContinue?`)) return;
    }
    clearImportPreview();
    const { mode, lat, lng, combined, name, code, category, description, landmarks, photo } = m;
    await setSetting(mappingKey, { mode, lat, lng, combined, name, code, category, description, landmarks, photo });
    const { locations, skipped } = applyMapping(rows, m);
    await saveImported({ locations, photos: [], skipped }, dsMode === 'update'
      ? { mode: 'update', datasetId: $('#ds-target', body).value, columns, removeMissing }
      : { mode: 'new', datasetName: $('#ds-name', body).value.trim() || filename, columns });
  };
  refresh();
}

/** Plain object of short strings only — imported `fields` are untrusted. */
function cleanFields(f) {
  if (!f || typeof f !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(f).slice(0, 500)) {
    if (v != null && v !== '') out[String(k).slice(0, 100)] = String(v).slice(0, 1000);
  }
  return out;
}

/** Imported files are untrusted: coerce types and drop anything that could inject markup. */
function sanitiseIncoming(input) {
  const raw = {
    ...input,
    lat: Number(input.lat), lng: Number(input.lng),
    name: String(input.name ?? 'Unnamed place'),
    code: input.code == null ? '' : String(input.code),
    thumb: safeThumb(input.thumb),
    fields: cleanFields(input.fields),
    datasetId: input.datasetId == null ? undefined : String(input.datasetId),
  };
  if (!raw.fields) delete raw.fields;
  if (!raw.thumb) delete raw.thumb;
  if (!raw.datasetId) delete raw.datasetId;
  const ok = Number.isFinite(raw.lat) && Number.isFinite(raw.lng) && Math.abs(raw.lat) <= 90 && Math.abs(raw.lng) <= 180;
  return ok ? raw : null;
}

/** Deletes places together with their photos and cached routes, in batches. */
async function deletePlaces(places) {
  const ids = places.map((p) => p.id);
  const photoIds = [];
  for (const id of ids) for (const ph of await photosFor(id)) { photoIds.push(ph.id); forgetPhotoUrl(ph.id); }
  await db.delMany('photos', photoIds);
  await db.delMany('routes', ids);
  await db.delMany('locations', ids);
  return { places: ids.length, photos: photoIds.length };
}

/**
 * Saves an import.
 *  - mode 'bundle': a Field Navigator export — matched by id, code or name+location across all places.
 *  - mode 'new':    a new dataset (import batch); every row becomes a new place in it.
 *  - mode 'update': batch-update an existing dataset — matched rows are updated (photos, visited
 *                   status and history are kept), new rows added, and, if `removeMissing`, places
 *                   no longer in the file are deleted.
 */
async function saveImported(parsed, { mode = 'bundle', datasetId = null, datasetName = '', columns = [], removeMissing = false } = {}) {
  const now = Date.now();
  const records = [];
  const photoJobs = [];
  const incoming = [];
  for (const input of parsed.locations) {
    const raw = sanitiseIncoming(input);
    if (raw) incoming.push(raw); else parsed.skipped++;
  }
  const strip = ({ photoUrl, ...rest }) => rest;
  let summary = '';
  let removed = { places: 0, photos: 0 };

  if (mode === 'bundle') {
    const byCode = new Map(state.locations.filter((l) => l.code).map((l) => [l.code, l]));
    for (const raw of incoming) {
      let existing = raw.id ? state.locations.find((l) => l.id === raw.id) : null;
      existing ??= raw.code ? byCode.get(raw.code) : null;
      existing ??= state.locations.find((l) => l.name === raw.name && distance(l.lat, l.lng, raw.lat, raw.lng) < 10);
      records.push({ ...existing, ...strip(raw), id: existing?.id || raw.id || uid(), updatedAt: now, createdAt: existing?.createdAt || raw.createdAt || now });
    }
    for (const ds of parsed.datasets || []) {
      if (ds && ds.id) await db.put('datasets', { id: String(ds.id), name: String(ds.name || 'Imported dataset').slice(0, 120), createdAt: Number(ds.createdAt) || now, updatedAt: now, columns: Array.isArray(ds.columns) ? ds.columns.map(String).slice(0, 500) : [] });
    }
    summary = `Imported ${records.length} place${records.length === 1 ? '' : 's'}`;
  } else if (mode === 'new') {
    datasetId = uid();
    await db.put('datasets', { id: datasetId, name: datasetName || 'Imported places', createdAt: now, updatedAt: now, columns });
    for (const raw of incoming) {
      const rec = { ...strip(raw), id: uid(), datasetId, createdAt: now, updatedAt: now };
      records.push(rec);
      if (raw.photoUrl) photoJobs.push([rec, raw.photoUrl]);
    }
    summary = `Dataset "${datasetName}": ${records.length} place${records.length === 1 ? '' : 's'} added`;
  } else {
    const ds = await db.get('datasets', datasetId);
    const plan = planDatasetUpdate(state.locations.filter((l) => (l.datasetId || '') === datasetId), incoming);
    for (const { existing, incoming: raw } of plan.updates) {
      // Keep the user's own work (photos/thumb, visited, created date); replace the data columns.
      records.push({ ...existing, ...strip(raw), id: existing.id, datasetId, thumb: existing.thumb || raw.thumb, visited: existing.visited, visitedAt: existing.visitedAt, createdAt: existing.createdAt, updatedAt: now });
      if (raw.photoUrl && !existing.thumb) photoJobs.push([records[records.length - 1], raw.photoUrl]);
    }
    for (const raw of plan.adds) {
      const rec = { ...strip(raw), id: uid(), datasetId, createdAt: now, updatedAt: now };
      records.push(rec);
      if (raw.photoUrl) photoJobs.push([rec, raw.photoUrl]);
    }
    if (removeMissing && plan.removals.length) removed = await deletePlaces(plan.removals);
    if (ds) await db.put('datasets', { ...ds, updatedAt: now, columns: columns.length ? columns : ds.columns });
    summary = `Dataset "${ds?.name || datasetName}": ${plan.updates.length} updated, ${plan.adds.length} added${removeMissing ? `, ${removed.places} removed` : plan.removals.length ? `, ${plan.removals.length} not in file (kept)` : ''}`;
  }
  // Remove every old record's photoUrl before saving: it is only used to fetch the photo once.
  for (const r of records) delete r.photoUrl;
  await db.putMany('locations', records);
  if (parsed.photos.length) {
    const photos = (await Promise.all(parsed.photos.map(async (p) => {
      try {
        const ph = await photoFromExport(p);
        if (!(ph.blob instanceof Blob) || !ph.blob.type.startsWith('image/')) return null;
        return { ...ph, id: String(ph.id), locationId: String(ph.locationId), thumb: safeThumb(ph.thumb),
          lat: Number.isFinite(Number(ph.lat)) && ph.lat !== null ? Number(ph.lat) : null,
          lng: Number.isFinite(Number(ph.lng)) && ph.lng !== null ? Number(ph.lng) : null };
      } catch { return null; }
    }))).filter(Boolean);
    await db.putMany('photos', photos);
    parsed.photos = photos;
  }
  await loadLocations();
  await askPersistentStorage();
  toast(`${summary}${parsed.skipped ? ` · ${parsed.skipped} skipped (no valid coordinates)` : ''}${parsed.photos.length ? ` · ${parsed.photos.length} photos` : ''}`, { ms: 7000 });
  if (records.length) {
    const b = L.latLngBounds(records.map((r) => [r.lat, r.lng]));
    map.fitBounds(b.pad(0.2), { maxZoom: 15 });
  }
  if (state.sheet === 'places') renderPlaces();
  // Photo URLs from CSVs are fetched one at a time so a weak link isn't flooded.
  if (photoJobs.length && network.online) {
    for (const [rec, url] of photoJobs) {
      try {
        const ph = await photoFromUrl(url, { locationId: rec.id, kind: 'destination' });
        rec.thumb = ph.thumb;
        await db.put('locations', rec);
      } catch { /* unreachable photo: ignore */ }
    }
    await loadLocations();
  }
}

async function loadSamples() {
  try {
    const res = await fetch('data/sample-locations.json');
    const existing = state.datasets.find((d) => d.name === 'Sample places');
    await saveImported(parseImport(await res.text(), 'sample-locations.json'),
      existing ? { mode: 'update', datasetId: existing.id } : { mode: 'new', datasetName: 'Sample places' });
  } catch { toast('Could not load samples'); }
}

// ---------------------------------------------------------------- place detail

/** "From above" image: stitched satellite tiles around the point (cached on save, so works offline). */
async function renderAerial(canvas, lat, lng) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  for (const [pid, z] of [['satellite', 18], ['satellite', 17], ['satellite', 16], ['streets', 17], ['streets', 15]]) {
    const p = PROVIDERS[pid];
    const n = 2 ** z;
    const px = ((lng + 180) / 360) * n * 256;
    const latR = (lat * Math.PI) / 180;
    const py = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n * 256;
    const x0 = Math.floor((px - W / 2) / 256), x1 = Math.floor((px + W / 2) / 256);
    const y0 = Math.floor((py - H / 2) / 256), y1 = Math.floor((py + H / 2) / 256);
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push({ x, y });
    const blobs = await Promise.all(jobs.map((j) => getTile(p, z, ((j.x % n) + n) % n, j.y, { allowNetwork: network.online })));
    if (blobs.filter(Boolean).length < jobs.length * 0.75) continue;
    ctx.fillStyle = '#ccc';
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < jobs.length; i++) {
      if (!blobs[i]) continue;
      const bmp = await createImageBitmap(blobs[i]);
      ctx.drawImage(bmp, Math.round(jobs[i].x * 256 - px + W / 2), Math.round(jobs[i].y * 256 - py + H / 2));
    }
    ctx.strokeStyle = '#ffd43b';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 22, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W / 2 - 34, H / 2); ctx.lineTo(W / 2 - 14, H / 2); ctx.moveTo(W / 2 + 14, H / 2); ctx.lineTo(W / 2 + 34, H / 2);
    ctx.moveTo(W / 2, H / 2 - 34); ctx.lineTo(W / 2, H / 2 - 14); ctx.moveTo(W / 2, H / 2 + 14); ctx.lineTo(W / 2, H / 2 + 34); ctx.stroke();
    return true;
  }
  ctx.fillStyle = '#ddd';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#555';
  ctx.font = '22px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('Aerial view not saved offline', W / 2, H / 2);
  return false;
}

function galleryHtml(photos, { aerial = true } = {}) {
  const dest = photos.filter((p) => p.kind !== 'landmark');
  const lms = photos.filter((p) => p.kind === 'landmark');
  return `<div class="gallery">
    ${dest.map((p) => `<figure><img src="${photoUrl(p)}" alt="Photo of destination" data-photo="${esc(p.id)}">${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}</figure>`).join('')}
    ${aerial ? '<figure><canvas class="aerial" width="640" height="420"></canvas><figcaption>From above (satellite)</figcaption></figure>' : ''}
    ${lms.map((p) => `<figure><img src="${photoUrl(p)}" alt="Landmark on the way" data-photo="${esc(p.id)}"><figcaption>On the way: ${esc(p.caption || 'landmark')}</figcaption></figure>`).join('')}
  </div>`;
}

/** Options for "Starting from": GPS, a pin dropped with "Start from here", a map pick, or any saved place. */
function fromOptions(dest) {
  const last = state.lastFromChoice || 'gps';
  const sel = (v) => (v === last ? 'selected' : '');
  const others = state.locations.filter((l) => l.id !== dest.id).slice(0, 3000);
  return `<option value="gps" ${sel('gps')}>📍 My current location (GPS)</option>
    ${state.pendingFrom ? `<option value="pin" ${sel('pin')}>📌 ${esc(state.pendingFrom.name)} (${fmtCoord(state.pendingFrom.lat, state.pendingFrom.lng)})</option>` : ''}
    <option value="pick">🗺 Pick a point on the map…</option>
    ${others.length ? `<optgroup label="Saved places">${others.map((l) => `<option value="${esc(l.id)}" ${sel(l.id)}>${esc(l.name)}</option>`).join('')}</optgroup>` : ''}`;
}

function pickStartOnMap(loc, profile) {
  closeSheet();
  state.picking = { loc, profile };
  toast('Tap the map where the trip starts', { ms: 0, onClick: () => { state.picking = null; } });
}

/** All original dataset columns for a place (collapsed when there are many). */
function fieldsHtml(loc) {
  const entries = Object.entries(loc.fields || {});
  if (!entries.length) return '';
  return `<details class="fields" ${entries.length <= 8 ? 'open' : ''}><summary>All data from import (${entries.length} columns)</summary>
    <dl class="kv">${entries.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>`;
}

async function openPlace(loc) {
  if (!loc) return;
  hideResults();
  if (!nav.target) map.setView([loc.lat, loc.lng], Math.max(map.getZoom(), 15));
  const photos = await photosFor(loc.id);
  const p = myPos();
  const d = distFromMe(loc);
  const navigatingHere = nav.target?.id === loc.id;
  const body = openSheet(loc.name, `
    ${galleryHtml(photos)}
    ${d != null ? `<p><b>${formatDistance(d)}</b> ${compassLabel(bearing(p.lat, p.lng, loc.lat, loc.lng))} of you (straight line)</p>` : ''}
    ${loc.landmarks ? `<div class="section-title">How to recognise it</div><div class="landmark-text">${esc(loc.landmarks)}</div>` : ''}
    ${loc.description ? `<p>${esc(loc.description)}</p>` : ''}
    ${navigatingHere ? '' : `<div class="section-title">Travel by</div>${seg('profile', PROFILE_LABELS, state.settings.profile)}
      <label class="field">Starting from<select id="pd-from">${fromOptions(loc)}</select></label>
      <div class="row"><button class="btn primary block" id="pd-nav">▶ Navigate here</button></div>`}
    <div class="row">
      <button class="btn small" id="pd-photo">📷 Add photo</button>
      <button class="btn small" id="pd-landmark">🪧 Add landmark photo</button>
    </div>
    <div class="row">
      <button class="btn small" id="pd-edit">✎ Edit</button>
      <button class="btn small" id="pd-share">↗ Share</button>
      <button class="btn small" id="pd-offline">⬇ Save area</button>
      ${loc.visited ? '' : '<button class="btn small" id="pd-visited">✓ Visited</button>'}
    </div>
    <div class="section-title">Details</div>
    <dl class="kv">
      ${loc.category ? `<dt>Category</dt><dd>${esc(loc.category)}</dd>` : ''}
      ${loc.code ? `<dt>Code</dt><dd>${esc(loc.code)}</dd>` : ''}
      <dt>Coordinates</dt><dd>${fmtCoord(loc.lat, loc.lng)}</dd>
      ${loc.visited ? `<dt>Visited</dt><dd>${loc.visitedAt ? new Date(loc.visitedAt).toLocaleString() : 'Yes'}</dd>` : ''}
      <dt>Photos</dt><dd>${photos.length}</dd>
    </dl>
    ${fieldsHtml(loc)}
    <div class="row"><button class="btn small ghost" id="pd-delete" style="color:var(--red)">Delete place</button></div>`, 'places');

  const canvas = $('canvas.aerial', body);
  if (canvas) renderAerial(canvas, loc.lat, loc.lng);
  let profile = state.settings.profile;
  if (!navigatingHere) {
    bindSeg(body, 'profile', (v) => { profile = v; saveSettings({ profile: v }); });
    $('#pd-nav', body).onclick = () => {
      const choice = $('#pd-from', body).value;
      state.lastFromChoice = choice;
      if (choice === 'gps') startNavigation(loc, profile, null);
      else if (choice === 'pin' && state.pendingFrom) startNavigation(loc, profile, state.pendingFrom);
      else if (choice === 'pick') pickStartOnMap(loc, profile);
      else {
        const o = state.locations.find((l) => l.id === choice);
        startNavigation(loc, profile, o ? { id: o.id, name: o.name, lat: o.lat, lng: o.lng } : null);
      }
    };
  }
  $('#pd-photo', body).onclick = () => pickPhoto(async (file) => {
    const caption = prompt('Caption (optional), e.g. "Main gate"') || '';
    const ph = await savePhoto(file, { locationId: loc.id, kind: 'destination', caption });
    if (!loc.thumb) { loc.thumb = ph.thumb; await db.put('locations', loc); renderPlaceMarkers(); }
    openPlace(loc);
  });
  $('#pd-landmark', body).onclick = () => addLandmarkPhoto(loc);
  $('#pd-edit', body).onclick = () => renderForm(loc);
  $('#pd-share', body).onclick = () => shareLocation(loc);
  $('#pd-offline', body).onclick = async () => {
    if (!network.online) { toast('Connect to the internet to save this area'); return; }
    toast('Saving map around this place for offline use…');
    await cacheAroundPoint(loc.lat, loc.lng, ['satellite', 'streets', 'topo'], 18);
    toast('Saved. The area around this place now works offline.');
  };
  const vis = $('#pd-visited', body);
  if (vis) vis.onclick = () => markVisited(loc);
  $('#pd-delete', body).onclick = async () => {
    if (!confirm(`Delete "${loc.name}" and its ${photos.length} photo(s) from this device? This cannot be undone.`)) return;
    for (const ph of photos) { await db.del('photos', ph.id); forgetPhotoUrl(ph.id); }
    await db.del('locations', loc.id);
    await db.del('routes', loc.id);
    await loadLocations();
    closeSheet();
    toast('Place deleted');
  };
  $$('img[data-photo]', body).forEach((img) => { img.onclick = () => window.open(img.src, '_blank'); });
}

async function markVisited(loc) {
  loc.visited = true;
  loc.visitedAt = Date.now();
  await db.put('locations', loc);
  await loadLocations();
  toast('Marked as visited');
  if (state.sheet === 'places') openPlace(loc);
}

async function shareLocation(loc) {
  const text = `${loc.name}\n${fmtCoord(loc.lat, loc.lng)}\n${loc.landmarks || ''}\nhttps://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=17/${loc.lat}/${loc.lng}`;
  if (navigator.share) { try { await navigator.share({ title: loc.name, text }); return; } catch { /* cancelled */ } }
  try { await navigator.clipboard.writeText(text); toast('Location copied — paste it into SMS or WhatsApp'); } catch { prompt('Copy this location', text); }
}

function pickPhoto(onFile, { camera = true } = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (camera) input.capture = 'environment';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    toast('Saving photo…');
    try { await onFile(f); toast('Photo saved'); } catch (e) { toast(`Photo failed: ${e.message}`); }
  };
  // Long-press-free fallback: if the device has no camera the picker opens the gallery anyway.
  input.click();
}

/** Landmark photo pinned at the user's current GPS position, attached to a destination. */
function addLandmarkPhoto(loc) {
  if (!loc?.id) { toast('Save this place first, then add landmarks to it'); return; }
  const p = myPos();
  if (!p) toast('No GPS fix yet — photo will not be pinned on the map', { ms: 5000 });
  pickPhoto(async (file) => {
    const caption = prompt('What is this landmark? e.g. "Turn left at this blue church"') || '';
    const pos = myPos();
    await savePhoto(file, { locationId: loc.id, kind: 'landmark', caption, lat: pos?.lat ?? null, lng: pos?.lng ?? null });
    if (nav.target?.id === loc.id) await showLandmarks(loc);
    if (state.sheet === 'places') openPlace(loc);
  });
}

// ---------------------------------------------------------------- add / edit

function renderForm(loc, preset = {}) {
  const editing = !!loc;
  const p = myPos();
  const c = map.getCenter();
  const lat = loc?.lat ?? preset.lat ?? p?.lat ?? c.lat;
  const lng = loc?.lng ?? preset.lng ?? p?.lng ?? c.lng;
  const cats = [...new Set(state.locations.map((l) => l.category).filter(Boolean))];
  const pending = [];
  const body = openSheet(editing ? `Edit ${loc.name}` : 'Add a place', `
    <form id="pf">
      <label class="field">Name *<input name="name" required value="${esc(loc?.name ?? preset.name ?? '')}" placeholder="e.g. Kanyakwar Primary School"></label>
      <div class="grid2">
        <label class="field">Category<input name="category" list="cat-list" value="${esc(loc?.category ?? '')}" placeholder="School, Clinic…"></label>
        <label class="field">Code / ID<input name="code" value="${esc(loc?.code ?? '')}"></label>
      </div>
      <datalist id="cat-list">${cats.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <div class="grid2">
        <label class="field">Latitude<input name="lat" inputmode="decimal" value="${lat.toFixed(6)}" required></label>
        <label class="field">Longitude<input name="lng" inputmode="decimal" value="${lng.toFixed(6)}" required></label>
      </div>
      <div class="row">
        <button type="button" class="btn small" id="pf-gps">⌖ Use my GPS position</button>
        <button type="button" class="btn small" id="pf-center">✛ Use map centre</button>
      </div>
      <div class="muted small-text" id="pf-gps-info">${p ? `Current GPS accuracy ±${Math.round(p.accuracy)} m` : 'Tip: stand at the place and use your GPS position.'}</div>
      <label class="field">How to recognise it / directions
        <textarea name="landmarks" placeholder="e.g. Green gate opposite the posho mill. Last 500 m is a footpath.">${esc(loc?.landmarks ?? '')}</textarea></label>
      <label class="field">Notes<textarea name="description">${esc(loc?.description ?? '')}</textarea></label>
      <div class="section-title">Photos of the place</div>
      <div class="row">
        <button type="button" class="btn small" id="pf-cam">📷 Take photo</button>
        <button type="button" class="btn small" id="pf-gal">🖼 Choose from gallery</button>
      </div>
      <div class="gallery" id="pf-previews"></div>
      <div class="row"><button class="btn primary block" type="submit">${editing ? 'Save changes' : 'Save place'}</button></div>
    </form>`, editing ? 'places' : 'add');

  const form = $('#pf', body);
  $('#pf-gps', body).onclick = () => {
    nav.watch();
    const pos = myPos();
    if (!pos) { toast('Waiting for GPS… try again in a few seconds'); return; }
    form.lat.value = pos.lat.toFixed(6);
    form.lng.value = pos.lng.toFixed(6);
    $('#pf-gps-info', body).textContent = `Set from GPS (±${Math.round(pos.accuracy)} m)`;
  };
  $('#pf-center', body).onclick = () => {
    const mc = map.getCenter();
    form.lat.value = mc.lat.toFixed(6);
    form.lng.value = mc.lng.toFixed(6);
  };
  const addPreview = (file) => {
    pending.push(file);
    const fig = document.createElement('figure');
    fig.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="">`;
    $('#pf-previews', body).appendChild(fig);
  };
  const pick = (camera) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = !camera;
    if (camera) input.capture = 'environment';
    input.onchange = () => [...input.files].forEach(addPreview);
    input.click();
  };
  $('#pf-cam', body).onclick = () => pick(true);
  $('#pf-gal', body).onclick = () => pick(false);

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const latN = Number(fd.lat), lngN = Number(fd.lng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN) || Math.abs(latN) > 90 || Math.abs(lngN) > 180) {
      toast('Latitude/longitude are not valid numbers'); return;
    }
    const rec = {
      ...(loc || {}), id: loc?.id || uid(), name: fd.name.trim(), category: fd.category.trim(), code: fd.code.trim(),
      lat: latN, lng: lngN, landmarks: fd.landmarks.trim(), description: fd.description.trim(),
      createdAt: loc?.createdAt || Date.now(), updatedAt: Date.now(),
    };
    toast('Saving…', { ms: 0 });
    for (const f of pending) {
      const ph = await savePhoto(f, { locationId: rec.id, kind: 'destination' });
      rec.thumb ??= ph.thumb;
    }
    await db.put('locations', rec);
    await loadLocations();
    await askPersistentStorage();
    toast('Place saved');
    openPlace(rec);
    // Pre-cache the aerial view around the new place while we still have signal.
    if (network.online && network.quality !== 'poor') cacheAroundPoint(rec.lat, rec.lng, ['satellite', 'streets'], network.quality === 'good' ? 18 : 17);
  };
}

// ---------------------------------------------------------------- navigation

// ---------------------------------------------------------------- nearest places panel

let nearbyLast = 0;
let nearbyTimer;
/**
 * Live table of the 3 loaded places closest to the user. Re-sorted on every GPS update
 * (throttled to once a second), so it keeps shifting as you travel.
 */
function updateNearby(force = false) {
  const panel = $('#nearby');
  const p = myPos();
  if (!panel || !state.settings.showNearby || !p || !state.locations.length) { if (panel) panel.hidden = true; return; }
  const now = Date.now();
  if (!force && now - nearbyLast < 1000) {
    clearTimeout(nearbyTimer);
    nearbyTimer = setTimeout(() => updateNearby(true), 1000 - (now - nearbyLast));
    return;
  }
  nearbyLast = now;
  const nearest = nearestPlaces(state.locations, p.lat, p.lng, 3);
  const heading = nav.heading;
  $('#nearby-list').innerHTML = nearest.map(({ place: l, d }) => {
    const brg = bearing(p.lat, p.lng, l.lat, l.lng);
    // Arrow is relative to the direction you face when the compass/GPS course is known.
    const rot = heading == null ? brg : (brg - heading + 360) % 360;
    const cls = [nav.target?.id === l.id ? 'is-target' : '', l.visited ? 'visited' : ''].join(' ');
    return `<tr data-id="${esc(l.id)}" class="${cls}">
      <td class="nb-name">${esc(l.name)}</td>
      <td class="nb-dist">${formatDistance(d)}</td>
      <td><svg class="nb-arrow" viewBox="0 0 100 100" style="transform:rotate(${Math.round(rot)}deg)"><path d="M50 6 80 88 50 70 20 88Z"/></svg></td>
      <td class="nb-dir">${compassLabel(brg)}</td></tr>`;
  }).join('');
  const first = nearest[0];
  $('#nearby-summary').textContent = first ? `${first.place.name} · ${formatDistance(first.d)}` : '';
  panel.classList.toggle('collapsed', !!state.settings.nearbyCollapsed);
  $('#nearby-chev').textContent = state.settings.nearbyCollapsed ? '▴' : '▾';
  panel.hidden = false;
  $$('#nearby-list tr').forEach((tr) => {
    tr.onclick = () => openPlace(state.locations.find((l) => l.id === tr.dataset.id));
  });
}

function setFollow(on) {
  state.follow = on;
  $('#btn-locate').classList.toggle('active', on);
  $('#hud-center').textContent = on ? '◎ Following' : '◎ Follow';
}

function meIcon(heading) {
  return L.divIcon({
    className: '', iconSize: [22, 22], iconAnchor: [11, 11],
    html: `<div class="me"><div class="cone" style="${heading == null ? 'display:none' : `transform:rotate(${heading}deg)`}"></div><div class="dot"></div></div>`,
  });
}

function updateMe() {
  const p = myPos();
  if (!p) return;
  if (!meMarker) {
    accCircle = L.circle([p.lat, p.lng], { radius: p.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    meMarker = L.marker([p.lat, p.lng], { icon: meIcon(nav.heading), zIndexOffset: 2000, interactive: false }).addTo(map);
  } else {
    meMarker.setLatLng([p.lat, p.lng]);
    accCircle.setLatLng([p.lat, p.lng]).setRadius(p.accuracy);
  }
  updateMeHeading();
  if (state.follow) map.panTo([p.lat, p.lng], { animate: true });
}

function updateMeHeading() {
  const cone = meMarker?.getElement()?.querySelector('.cone');
  if (!cone) return;
  const h = nav.heading;
  cone.style.display = h == null ? 'none' : '';
  if (h != null) cone.style.transform = `rotate(${h}deg)`;
}

async function showLandmarks(loc) {
  landmarksLayer.clearLayers();
  if (!loc?.id) return [];
  const lms = (await photosFor(loc.id)).filter((p) => p.kind === 'landmark' && p.lat != null);
  for (const lm of lms) {
    L.marker([lm.lat, lm.lng], {
      icon: L.divIcon({ className: '', iconSize: [40, 40], iconAnchor: [20, 20], html: `<div class="landmark-marker" style="background-image:url('${lm.thumb}')"></div>` }),
    }).bindPopup(`<img src="${photoUrl(lm)}" style="width:220px;border-radius:8px"><br><b>${esc(lm.caption || 'Landmark')}</b>`).addTo(landmarksLayer);
  }
  return lms;
}

/** `from` = { name, lat, lng } to plan from a chosen start point; null = from the live GPS position. */
async function startNavigation(loc, profile = state.settings.profile, from = null) {
  closeSheet();
  hideResults();
  document.body.classList.add('navigating');
  $('#hud').hidden = false;
  $('#hud-step').hidden = true;
  $('#hud-dist').textContent = '–';
  $('#hud-sub').textContent = nav.position || from ? 'Finding route…' : 'Waiting for GPS…';
  const fromEl = $('#hud-from');
  fromEl.textContent = `From: ${from ? from.name : 'my current location'} → ${loc.name}`;
  fromEl.hidden = false;
  const thumbBtn = $('#hud-photos');
  thumbBtn.hidden = !loc.thumb;
  if (loc.thumb) thumbBtn.style.backgroundImage = `url('${loc.thumb}')`;
  routeLayer.clearLayers();
  setFollow(true);
  nav.arrivalRadius = Number(state.settings.arrivalRadius) || 40;
  nav.enableCompass();
  const landmarks = await showLandmarks(loc);
  if (!loc.id) {
    L.marker([loc.lat, loc.lng], { icon: pinIcon({ ...loc, name: '★' }) }).addTo(routeLayer);
  }
  await nav.start(loc, { profile, landmarks, from });
}

function stopNavigation() {
  nav.stop();
  document.body.classList.remove('navigating');
  $('#hud').hidden = true;
  routeLayer.clearLayers();
  landmarksLayer.clearLayers();
  straightLine.setLatLngs([]);
  trackLine.setLatLngs([]);
  renderPlaceMarkers();
}

function drawRoute({ route, fromCache }) {
  routeLayer.clearLayers();
  const t = nav.target;
  L.polyline(route.coords, { color: '#0d4a2e', weight: 9, opacity: 0.5 }).addTo(routeLayer);
  L.polyline(route.coords, { color: '#2fb36b', weight: 5 }).addTo(routeLayer);
  const end = route.coords[route.coords.length - 1];
  // In remote areas the destination is often off the mapped road network: show the
  // remaining walk from the end of the road as a dashed line.
  if (t && distance(end[0], end[1], t.lat, t.lng) > 30) {
    L.polyline([end, [t.lat, t.lng]], { color: '#e76f24', weight: 4, dashArray: '4 8' }).addTo(routeLayer);
  }
  if (t && !t.id) L.marker([t.lat, t.lng], { icon: pinIcon({ ...t, name: '★' }) }).addTo(routeLayer);
  const from = nav.from;
  if (from) {
    L.marker([from.lat, from.lng], {
      icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: '<div class="start-marker">A</div>' }),
      title: `Start: ${from.name}`,
    }).addTo(routeLayer);
    // Dashed link if the chosen start point is off the road network.
    const s0 = route.coords[0];
    if (distance(s0[0], s0[1], from.lat, from.lng) > 30) L.polyline([[from.lat, from.lng], s0], { color: '#1a73e8', weight: 3, dashArray: '4 8' }).addTo(routeLayer);
  }
  const via = from ? ` from ${from.name}` : '';
  if (fromCache) toast(`Using saved ${PROFILE_LABELS[route.profile] || ''} route${via} (${new Date(route.fetchedAt).toLocaleDateString()})`);
  else toast(`Route${via}: ${formatDistance(route.distance)}, about ${formatDuration(route.duration)}. Tip: Offline tab → save map along route.`, { ms: 6000 });
  if ((state.follow && nav.position) || from) {
    const pts = [...route.coords, [t.lat, t.lng]];
    if (from) pts.push([from.lat, from.lng]);
    map.fitBounds(L.latLngBounds(pts).pad(0.1), { maxZoom: 16, paddingTopLeft: [0, $('#hud').offsetHeight] });
    setFollow(false);
    // When planning from elsewhere, leave the overview on screen; otherwise resume following.
    if (!from) setTimeout(() => setFollow(true), 4000);
  }
}

function updateHud(s) {
  if (!s.target) return;
  const arrow = $('#hud-arrow');
  if (!s.hasFix) {
    if (s.route) {
      // Planned route (chosen start point) but no GPS yet — still show the plan.
      const total = s.route.distance + (s.lastMile || 0);
      $('#hud-dist').textContent = formatDistance(total);
      $('#hud-sub').textContent = `Planned route · ~${formatDuration(s.route.duration)} · waiting for GPS to guide you`;
      const step = $('#hud-step');
      step.classList.remove('warn');
      step.textContent = s.route.steps[0] ? `First: ${s.route.steps[0].text}` : '';
      step.hidden = !step.textContent;
    } else $('#hud-sub').textContent = 'Waiting for GPS… (go outdoors, away from buildings)';
    return;
  }
  // With a compass the arrow points where to walk; without one it shows the bearing on a north-up map.
  const rot = s.relative ?? s.bearing;
  arrow.style.transform = `rotate(${rot}deg)`;
  arrow.classList.toggle('no-compass', s.relative == null);
  // Road distance while on the road; once off it (or off route) the straight line is what matters.
  const big = s.route && s.onRoad && !s.offRoute ? s.remaining : s.distance;
  $('#hud-dist').textContent = s.arrived ? 'Arrived' : formatDistance(big);
  const bits = [];
  if (s.route) bits.push(`${formatDistance(s.distance)} direct`);
  bits.push(`${s.bearingLabel} ${Math.round(s.bearing)}°`);
  if (s.eta && !s.arrived) bits.push(`~${formatDuration(s.eta)}`);
  bits.push(`GPS ±${Math.round(s.accuracy)} m`);
  if (s.relative == null) bits.push('tap arrow for compass');
  $('#hud-sub').textContent = bits.join(' · ');

  const step = $('#hud-step');
  step.classList.remove('warn');
  let text = '';
  if (s.arrived) text = `You are within ${Math.round(s.distance)} m of ${s.target.name}. Look for the landmarks in the photos.`;
  else if (s.route && s.notJoined) text = `Route starts at ${nav.from?.name || 'the start point'}: ${formatDistance(s.toStart)} ${s.toStartLabel} of you. Guidance begins when you reach it.`;
  else if (s.route && s.offRoute) { text = `Off the route — head ${s.bearingLabel}. ${network.online ? 'Re-routing soon…' : 'Offline: follow the arrow.'}`; step.classList.add('warn'); }
  else if (s.route && !s.onRoad && s.lastMile > 60) text = `Leave the road: ${formatDistance(s.lastMile)} ${s.bearingLabel} on foot/track to the destination.`;
  else if (s.nextStep) text = `In ${formatDistance(s.nextStep.distance)}: ${s.nextStep.text}`;
  else if (!s.route) text = `No road route${network.online ? '' : ' (offline)'} — follow the arrow ${s.bearingLabel}.`;
  step.textContent = text;
  step.hidden = !text;

  const p = nav.position;
  straightLine.setLatLngs(!s.route && !s.arrived ? [[p.lat, p.lng], [s.target.lat, s.target.lng]] : []);
  trackLine.setLatLngs(nav.track.map(([a, b]) => [a, b]));
}

function openArrival(loc) {
  photosFor(loc.id || '__none').then((photos) => {
    const body = openSheet('You have arrived', `
      <div class="arrived-banner"><div class="big">📍</div><b>${esc(loc.name)}</b><div class="muted">Within ${Math.round(distFromMe(loc) ?? 0)} m (GPS ±${Math.round(nav.position?.accuracy ?? 0)} m)</div></div>
      ${photos.length || loc.id ? galleryHtml(photos) : ''}
      ${loc.landmarks ? `<div class="section-title">How to recognise it</div><div class="landmark-text">${esc(loc.landmarks)}</div>` : ''}
      <div class="row">
        ${loc.id ? '<button class="btn primary" id="ar-visited">✓ Mark visited</button><button class="btn" id="ar-photo">📷 Add photo</button>' : '<button class="btn primary" id="ar-save">Save this place</button>'}
      </div>
      <div class="row"><button class="btn block" id="ar-stop">Finish navigation</button></div>`, 'places');
    const canvas = $('canvas.aerial', body);
    if (canvas) renderAerial(canvas, loc.lat, loc.lng);
    $('#ar-stop', body).onclick = () => { stopNavigation(); closeSheet(); };
    if (loc.id) {
      $('#ar-visited', body).onclick = async () => { await markVisited(loc); stopNavigation(); closeSheet(); };
      $('#ar-photo', body).onclick = () => pickPhoto(async (file) => {
        const ph = await savePhoto(file, { locationId: loc.id, kind: 'destination', caption: 'Taken on arrival' });
        if (!loc.thumb) { loc.thumb = ph.thumb; await db.put('locations', loc); }
        openArrival(loc);
      });
    } else {
      $('#ar-save', body).onclick = () => renderForm(null, { lat: loc.lat, lng: loc.lng });
    }
  });
}

function wireNavigator() {
  nav.addEventListener('position', () => { updateMe(); updateNearby(); });
  nav.addEventListener('heading', () => updateNearby());
  nav.addEventListener('started', () => { renderPlaceMarkers(); updateNearby(true); });
  nav.addEventListener('stopped', () => updateNearby(true));
  $('#nearby-head').onclick = async () => {
    await saveSettings({ nearbyCollapsed: !state.settings.nearbyCollapsed });
    updateNearby(true);
  };
  nav.addEventListener('heading', () => updateMeHeading());
  nav.addEventListener('update', (e) => updateHud(e.detail));
  nav.addEventListener('route', (e) => drawRoute(e.detail));
  nav.addEventListener('route-error', (e) => toast(`${e.detail}. Follow the arrow — it always points to the destination.`, { ms: 5000 }));
  nav.addEventListener('arrived', (e) => openArrival(e.detail));
  nav.addEventListener('error', (e) => toast(e.detail, { ms: 5000 }));
  nav.addEventListener('landmark', (e) => {
    const lm = e.detail;
    toast(`<img src="${photoUrl(lm)}" alt=""><div><b>Landmark nearby</b><br>${esc(lm.caption || 'Look around for this view')}</div>`, { html: true, cls: 'landmark', ms: 12000 });
  });

  $('#hud-stop').onclick = () => stopNavigation();
  $('#hud-center').onclick = () => { setFollow(!state.follow); if (state.follow && nav.position) map.setView([nav.position.lat, nav.position.lng], Math.max(map.getZoom(), 16)); };
  $('#hud-photos').onclick = () => { const t = state.locations.find((l) => l.id === nav.target?.id); if (t) openPlace(t); };
  $('#hud-landmark').onclick = () => addLandmarkPhoto(state.locations.find((l) => l.id === nav.target?.id) || nav.target);
  $('.arrow-wrap').onclick = async () => {
    const ok = await nav.enableCompass();
    toast(ok ? 'Compass on. Hold the phone flat; wave it in a figure-8 if the arrow drifts.' : 'Compass not available on this device — the arrow shows the bearing on a north-up map.', { ms: 5000 });
  };
}

// ---------------------------------------------------------------- offline maps tab

async function renderOffline() {
  const stats = await tileStats();
  const areas = (await db.all('areas')).sort((a, b) => b.savedAt - a.savedAt);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const z = Math.round(map.getZoom());
  const { id: activeId } = resolveLayer();
  const provider = state.offlineProvider || (activeId === 'satellite' ? 'satellite' : activeId);
  const providers = Object.values(PROVIDERS).filter((p) => !p.overlay);
  const route = nav.route;
  const body = openSheet('Offline maps', `
    <div class="notice ${network.online ? '' : 'warn'}">
      <b>${{ good: 'Good connection', fair: 'Fair connection', poor: 'Weak connection', offline: 'No connection' }[network.quality]}.</b>
      ${network.online ? 'Save the areas you will visit now, while you have signal.' : 'Showing only maps saved on this phone. Areas you have not saved appear as a blurred zoom of the nearest saved level, or a grey grid.'}
    </div>
    ${state.download ? `<div class="card"><b>${esc(state.download.label)}</b><progress id="dl-prog" max="1" value="0"></progress>
      <div class="muted small-text" id="dl-text">Starting…</div><div class="row"><button class="btn small danger" id="dl-cancel">Cancel</button></div></div>` : ''}
    <div class="section-title">Save the area on screen</div>
    <label class="field">Map style<select id="of-provider">${providers.map((p) => `<option value="${p.id}" ${p.id === provider ? 'selected' : ''}>${esc(p.name)}${p.overlays ? ' + roads & labels' : ''}</option>`).join('')}</select></label>
    <div class="grid2">
      <label class="field">From zoom<input id="of-zmin" type="number" min="2" max="19" value="${Math.max(2, Math.min(z, 12))}"></label>
      <label class="field">To zoom (detail)<input id="of-zmax" type="number" min="2" max="19" value="${Math.min(Math.max(z + 3, 15), 17)}"></label>
    </div>
    <div class="muted small-text" id="of-est"></div>
    <div class="row"><button class="btn primary block" id="of-save" ${network.online && !state.download ? '' : 'disabled'}>⬇ Download this area</button></div>
    ${route ? `<div class="row"><button class="btn block" id="of-route" ${network.online && !state.download ? '' : 'disabled'}>⬇ Save map along current route</button></div>` : ''}
    <div class="row"><button class="btn block ghost" id="of-places" ${network.online && !state.download && state.locations.length ? '' : 'disabled'}>⬇ Save aerial view around all ${state.locations.length} places</button></div>

    <div class="section-title">Saved areas</div>
    ${areas.length ? areas.map((a) => `<div class="place" style="cursor:default">
      <span class="thumb">🗺</span><div class="meta"><div class="name">${esc(a.name)}</div>
      <div class="muted">${esc(PROVIDERS[a.provider]?.name || a.provider)} · z${a.zMin}–${a.zMax} · ${(a.tiles ?? a.saved + a.skipped).toLocaleString()} map squares${a.failed ? ` · ${a.failed} failed (retry to fill)` : ''}</div>
      <div class="muted small-text">${new Date(a.savedAt).toLocaleString()}</div></div>
      <button class="btn small" data-show="${esc(a.id)}">Show</button></div>`).join('') : '<p class="muted">None yet. Maps you browse while online are also kept automatically.</p>'}

    <div class="section-title">Storage on this phone</div>
    <p>${stats.tiles.toLocaleString()} map tiles saved · ${(stats.usage / 1048576).toFixed(0)} MB used${stats.quota ? ` of ~${(stats.quota / 1073741824).toFixed(1)} GB available` : ''}</p>
    ${persisted ? '<p class="muted small-text">✓ Storage is protected from automatic clean-up.</p>' : '<div class="row"><button class="btn small" id="of-persist">Protect saved maps from clean-up</button></div>'}
    <div class="row"><button class="btn small ghost" id="of-clear" style="color:var(--red)">Delete all saved map tiles</button></div>`, 'offline');

  const sel = $('#of-provider', body), zmin = $('#of-zmin', body), zmax = $('#of-zmax', body);
  const estimate = () => {
    const b = map.getBounds();
    const bounds = { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
    const lo = Math.min(Number(zmin.value), Number(zmax.value)), hi = Math.max(Number(zmin.value), Number(zmax.value));
    const est = estimateDownload(sel.value, bounds, lo, Math.min(hi, PROVIDERS[sel.value].maxNativeZoom));
    const over = est.tiles > est.limit;
    $('#of-est', body).innerHTML = `${est.tiles.toLocaleString()} tiles (~${est.mb.toFixed(0)} MB).${over
      ? ` <b style="color:var(--red)">Too large for this map style (limit ${est.limit.toLocaleString()}).</b> Zoom in, lower "To zoom", or use a custom tile server in Settings.`
      : network.quality === 'poor' ? ' Weak signal: this may take a long time; it resumes where it left off if you retry.' : ''}`;
    $('#of-save', body).disabled = over || !network.online || !!state.download;
    return { bounds, lo, hi: Math.min(hi, PROVIDERS[sel.value].maxNativeZoom), est };
  };
  [sel, zmin, zmax].forEach((el) => { el.oninput = estimate; });
  sel.onchange = () => { state.offlineProvider = sel.value; estimate(); };
  estimate();

  $('#of-save', body).onclick = () => {
    const { bounds, lo, hi, est } = estimate();
    const name = prompt('Name this area (e.g. "Kisumu West sub-county")', `Area ${new Date().toLocaleDateString()}`);
    if (name === null) return;
    runDownload(`Saving "${name}"`, sel.value, tilesInBounds(bounds, lo, hi), { name, bounds, zMin: lo, zMax: hi, expected: est.tiles });
  };
  const rb = $('#of-route', body);
  if (rb) {
    rb.onclick = () => {
      const t = nav.target;
      const line = [...nav.route.coords, [t.lat, t.lng]];
      const tiles = corridorTiles(line, 400, 11, Math.min(17, PROVIDERS[sel.value].maxNativeZoom));
      const lats = line.map((c) => c[0]), lngs = line.map((c) => c[1]);
      runDownload(`Saving route to ${t.name}`, sel.value, tiles, {
        name: `Route to ${t.name}`, zMin: 11, zMax: 17,
        bounds: { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) },
      });
    };
  }
  $('#of-places', body).onclick = async () => {
    const tiles = new Map();
    for (const l of state.locations.slice(0, 300)) {
      for (const t of tilesInBounds({ south: l.lat - 0.003, north: l.lat + 0.003, west: l.lng - 0.003, east: l.lng + 0.003 }, 14, 17)) tiles.set(`${t.z}/${t.x}/${t.y}`, t);
    }
    const lats = state.locations.map((l) => l.lat), lngs = state.locations.map((l) => l.lng);
    runDownload('Saving aerial views around places', 'satellite', [...tiles.values()], {
      name: `Around ${state.locations.length} places`, zMin: 14, zMax: 17,
      bounds: { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) },
    });
  };
  $$('[data-show]', body).forEach((b) => {
    b.onclick = () => {
      const a = areas.find((x) => x.id === b.dataset.show);
      map.fitBounds([[a.bounds.south, a.bounds.west], [a.bounds.north, a.bounds.east]]);
      closeSheet();
    };
  });
  const persist = $('#of-persist', body);
  if (persist) persist.onclick = async () => { await askPersistentStorage(); renderOffline(); };
  $('#of-clear', body).onclick = async () => {
    if (!confirm('Delete ALL saved map tiles from this phone? Your places and photos are kept. You will need signal to download maps again.')) return;
    await clearTiles();
    await db.clear('areas');
    applyBaseLayer();
    toast('Saved map tiles deleted');
    renderOffline();
  };
  const cancel = $('#dl-cancel', body);
  if (cancel) cancel.onclick = () => state.download?.ctrl.abort();
}

async function runDownload(label, providerId, tiles, area) {
  await askPersistentStorage();
  const ctrl = new AbortController();
  const list = [...tiles];
  state.download = { label, ctrl };
  renderOffline();
  const stats = await downloadTiles(providerId, list, {
    signal: ctrl.signal,
    onProgress: (s) => {
      const prog = $('#dl-prog'), text = $('#dl-text');
      if (prog) prog.value = s.done / s.total;
      if (text) text.textContent = `${s.done.toLocaleString()} / ${s.total.toLocaleString()} · ${s.saved} new · ${s.skipped} already saved${s.failed ? ` · ${s.failed} failed` : ''}`;
    },
  });
  state.download = null;
  await db.put('areas', { id: uid(), provider: providerId, savedAt: Date.now(), tiles: list.length, ...area, ...stats });
  const msg = ctrl.signal.aborted ? 'Download cancelled (what finished is kept)'
    : stats.failed ? `Saved with ${stats.failed} tiles failed — tap Download again later to fill gaps` : 'Area saved for offline use ✓';
  toast(msg, { ms: 6000 });
  if (state.sheet === 'offline') renderOffline();
}

// ---------------------------------------------------------------- settings tab

async function renderSettings() {
  const s = state.settings;
  const tracks = (await db.all('tracks')).sort((a, b) => b.savedAt - a.savedAt).slice(0, 5);
  const layerOpts = { auto: 'Auto', streets: 'Streets', topo: 'Terrain', satellite: 'Satellite' };
  if (PROVIDERS.custom) layerOpts.custom = 'Custom';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const body = openSheet('Settings', `
    ${standalone ? '' : `<div class="card"><b>Install the app</b><p class="small-text">Installing puts Field Navigator on your home screen and lets it open with no internet.</p>
      ${state.installPrompt ? '<button class="btn primary block" id="st-install">Install app</button>'
        : '<p class="muted small-text">On Android/Chrome: menu ⋮ → <b>Install app</b> / <b>Add to Home screen</b>.<br>On iPhone/Safari: Share □↑ → <b>Add to Home Screen</b>.</p>'}</div>`}

    <div class="section-title">Map detail</div>
    ${seg('detail', { auto: 'Auto', light: 'Light (save data)', detailed: 'Detailed' }, s.detail)}
    <p class="muted small-text">Auto uses detailed satellite imagery with roads and labels, sharper tiles on high-resolution screens on a good connection, and lightweight street maps when the signal is weak.</p>

    <div class="section-title">Map style</div>
    ${seg('layer', layerOpts, s.baseLayer)}

    <div class="section-title">Default travel mode</div>
    ${seg('profile', PROFILE_LABELS, s.profile)}

    <div class="section-title">Nearest places panel</div>
    ${seg('nearby', { on: 'Show while travelling', off: 'Hide' }, s.showNearby ? 'on' : 'off')}
    <p class="muted small-text">A small table of the 3 loaded places closest to you, updated as you move. Tap a row to open that place.</p>

    <label class="field">Arrival alert distance
      <select id="st-radius">${[20, 40, 80, 150].map((r) => `<option value="${r}" ${Number(s.arrivalRadius) === r ? 'selected' : ''}>${r} m</option>`).join('')}</select></label>

    <label class="field">Custom tile server (optional)
      <input id="st-custom" placeholder="https://tiles.example.org/{z}/{x}/{y}.png" value="${esc(s.customTileUrl)}"></label>
    <p class="muted small-text">For large offline downloads use your organisation's own tile server or a commercial key. The public OpenStreetMap servers do not allow bulk downloads.</p>
    <div class="row"><button class="btn small" id="st-custom-save">Save tile server</button></div>

    <div class="section-title">Recorded tracks</div>
    ${tracks.length ? tracks.map((t) => `<div class="place" style="cursor:default"><span class="thumb">〰</span>
      <div class="meta"><div class="name">${esc(t.target || 'Track')}</div><div class="muted">${new Date(t.savedAt).toLocaleString()} · ${t.points.length} pts</div></div>
      <button class="btn small" data-track="${esc(t.id)}">Show</button><button class="btn small" data-gpx="${esc(t.id)}">GPX</button></div>`).join('')
      : '<p class="muted">Your path is recorded while navigating, so you can retrace your way back.</p>'}

    <div class="section-title">Data</div>
    <div class="row">
      <button class="btn small" id="st-import">⬆ Import places</button>
      <button class="btn small" id="st-export">⬇ Export places</button>
    </div>
    <div class="row"><button class="btn small ghost" id="st-wipe" style="color:var(--red)">Delete all places & photos</button></div>
    <p class="muted small-text">Field Navigator v1.0 · Map data © OpenStreetMap contributors · Imagery © Esri · Routing: FOSSGIS OSRM. Everything you save stays on this device.</p>`, 'settings');

  bindSeg(body, 'detail', async (v) => { await saveSettings({ detail: v }); applyBaseLayer(); updatePill(); });
  bindSeg(body, 'layer', async (v) => { await saveSettings({ baseLayer: v }); applyBaseLayer(); updatePill(); });
  bindSeg(body, 'profile', (v) => saveSettings({ profile: v }));
  bindSeg(body, 'nearby', async (v) => { await saveSettings({ showNearby: v === 'on' }); updateNearby(true); });
  $('#st-radius', body).onchange = (e) => { saveSettings({ arrivalRadius: Number(e.target.value) }); nav.arrivalRadius = Number(e.target.value); };
  $('#st-custom-save', body).onclick = async () => {
    const url = $('#st-custom', body).value.trim();
    if (url && !/^https:\/\/.+\{z\}.+\{x\}.+\{y\}/.test(url)) { toast('URL must start with https:// and contain {z}, {x} and {y}'); return; }
    await saveSettings({ customTileUrl: url, baseLayer: url ? 'custom' : (state.settings.baseLayer === 'custom' ? 'auto' : state.settings.baseLayer) });
    setCustomProvider(url);
    state.layerKey = null;
    applyBaseLayer();
    toast(url ? 'Custom tile server saved and selected' : 'Custom tile server removed');
    renderSettings();
  };
  const inst = $('#st-install', body);
  if (inst) inst.onclick = async () => { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; renderSettings(); };
  $$('[data-track]', body).forEach((b) => {
    b.onclick = () => {
      const t = tracks.find((x) => x.id === b.dataset.track);
      trackLine.setLatLngs(t.points.map(([a, c]) => [a, c]));
      map.fitBounds(trackLine.getBounds().pad(0.1));
      closeSheet();
    };
  });
  $$('[data-gpx]', body).forEach((b) => {
    b.onclick = () => {
      const t = tracks.find((x) => x.id === b.dataset.gpx);
      download(`${(t.target || 'track').replace(/[^\w-]+/g, '_')}.gpx`, new Blob([trackToGpx(t)], { type: 'application/gpx+xml' }));
    };
  });
  $('#st-import', body).onclick = () => $('#file-import').click();
  $('#st-export', body).onclick = () => renderExport();
  $('#st-wipe', body).onclick = async () => {
    if (!confirm(`Delete all ${state.locations.length} places and every photo from this phone? This cannot be undone. Export first if you need a copy.`)) return;
    await Promise.all(['locations', 'photos', 'routes', 'datasets'].map((s) => db.clear(s)));
    await loadLocations();
    toast('All places deleted');
    renderSettings();
  };
}

// ---------------------------------------------------------------- boot

function renderWelcome() {
  const body = openSheet('Welcome to Field Navigator', `
    <p>Find field sites with or without internet.</p>
    <ol class="small-text">
      <li><b>Load your sites</b> — import a CSV/GeoJSON list, or tap anywhere on the map to drop a pin.</li>
      <li><b>While you have signal</b>, open <b>Offline</b> and download the map for the areas you'll visit.</li>
      <li><b>Add photos</b> of each site (gate, signboard, building) and of landmarks on the way, so the next person recognises it.</li>
      <li><b>Navigate</b> — the arrow always points to the destination, even with no network.</li>
    </ol>
    <div class="row">
      <button class="btn primary" id="w-import">⬆ Import sites</button>
      <button class="btn" id="w-sample">Try sample places</button>
    </div>
    <div class="row"><button class="btn block ghost" id="w-close">Explore the map</button></div>`, null);
  $('#w-import', body).onclick = () => $('#file-import').click();
  $('#w-sample', body).onclick = () => { closeSheet(); loadSamples(); };
  $('#w-close', body).onclick = closeSheet;
}

function wireUi() {
  $('#sheet-close').onclick = closeSheet;
  $$('#tabbar button').forEach((b) => {
    b.onclick = () => {
      const tab = b.dataset.tab;
      if (state.sheet === tab) { closeSheet(); return; }
      if (tab === 'places') renderPlaces();
      if (tab === 'add') renderForm(null);
      if (tab === 'offline') renderOffline();
      if (tab === 'settings') renderSettings();
    };
  });
  $('#net-pill').onclick = () => renderOffline();
  $('#btn-locate').onclick = async () => {
    nav.watch();
    nav.enableCompass();
    if (state.follow) { setFollow(false); return; }
    setFollow(true);
    const p = myPos();
    if (p) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 16));
    else toast('Finding your location… (works offline — GPS needs no internet)');
  };
  nav.addEventListener('position', function first() {
    nav.removeEventListener('position', first);
    if (state.follow) map.setView([nav.position.lat, nav.position.lng], Math.max(map.getZoom(), 16));
  });
  $('#btn-layers').onclick = async () => {
    const order = ['auto', 'streets', 'topo', 'satellite', ...(PROVIDERS.custom ? ['custom'] : [])];
    const next = order[(order.indexOf(state.settings.baseLayer) + 1) % order.length];
    await saveSettings({ baseLayer: next });
    applyBaseLayer();
    updatePill();
    const { id } = resolveLayer();
    toast(`Map style: ${next === 'auto' ? `Auto (${PROVIDERS[id].name})` : PROVIDERS[next].name}`);
  };

  const search = $('#search');
  let searchTimer;
  search.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => renderSearch(search.value, false), 120); };
  search.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); renderSearch(search.value, true); }
    if (e.key === 'Escape') { search.value = ''; hideResults(); search.blur(); }
  };
  search.onfocus = () => { if (search.value.trim()) renderSearch(search.value, false); };

  $('#file-import').onchange = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) { toast('Reading file…', { ms: 0 }); await importText(await f.text(), f.name); }
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    toast('Tip: install Field Navigator so it opens without internet — tap here', { ms: 8000, onClick: () => renderSettings() });
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offerUpdate = (worker) => toast('A new version is ready — tap to update', {
      ms: 0, onClick: () => worker.postMessage('skip-waiting'),
    });
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w); });
    });
  }).catch(() => {});
  // Reload only when an update replaces an existing worker — not on the very first install
  // (clients.claim() fires controllerchange then too, which would wipe the welcome screen).
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
}

async function boot() {
  for (const k of Object.keys(DEFAULTS)) state.settings[k] = await getSetting(k, DEFAULTS[k]);
  setCustomProvider(state.settings.customTileUrl);
  network.init();
  state.stableQuality = network.quality;
  initMap();
  updatePill();
  network.onChange(() => { updatePill(); scheduleLayerRefresh(); });
  wireUi();
  wireNavigator();
  await loadLocations();
  registerServiceWorker();
  // Start GPS straight away: a cold GPS fix in remote areas can take a minute or more.
  nav.watch();
  if (!state.locations.length && !(await getSetting('welcomed', false))) {
    await setSetting('welcomed', true);
    renderWelcome();
  }
}

boot();

// Exposed for debugging in the browser console.
window.fieldNav = { map: () => map, nav, state, lngToTileX, latToTileY };
