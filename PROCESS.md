# Field Navigator — Development Process

An offline-first, installable navigation web app (PWA) for field teams working in remote,
low-connectivity areas. Plain HTML/CSS/JavaScript (ES modules), no build step, no backend.

## Setup

Requirements: Node.js 18+ (only for the dev server, tests and copying Leaflet).

```bash
npm install          # installs Leaflet and copies it into public/vendor/leaflet (postinstall)
npm start            # serves public/ at http://localhost:8080
npm test             # unit tests for the pure logic (geo maths, tiles, importers)
npm run icons        # regenerate PNG app icons (only if you change the design)
```

Use `PORT=3000 npm start` to change the port. Service workers only run on `https://` or
`http://localhost`, so test install/offline behaviour on localhost or a deployed HTTPS URL.

### Testing on a phone

The phone must reach the app over HTTPS. Options:
- Deploy `public/` to any static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages, an
  internal web server). There is no server-side code.
- Or, for quick tests, use Chrome remote debugging with port forwarding so the phone can open
  `http://localhost:8080`.

### Testing offline on desktop

Chrome DevTools → Application → Service Workers → tick **Offline**, or Network → **Offline**.
DevTools → Network → throttling ("Slow 3G") simulates the weak-signal mode.

## Releasing an update

`public/sw.js` serves the app shell **cache-first** so the app opens instantly with no signal.
That means installed copies only pick up changes when the service worker changes:

1. Bump `VERSION` in `public/sw.js` (e.g. `fn-shell-v4` → `fn-shell-v5`).
2. If you added a new file to the shell, add it to the `SHELL` list.
3. Deploy. Users see "A new version is ready — tap to update" on next launch.

Tile caches (`fn-tiles-v1`) are never deleted by a shell update, so saved maps survive upgrades.

During development, either tick DevTools → Application → Service Workers → **Update on reload**,
or run this in the console before reloading:
`(await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister()); caches.delete('fn-shell-v4')`

## Architecture

```
public/                     ← deploy this folder as-is
  index.html                app shell markup
  manifest.webmanifest      PWA install metadata
  sw.js                     service worker: precaches the shell (cache-first)
  css/app.css               mobile-first, high-contrast styles (light + dark)
  js/app.js                 UI: map, search, sheets (Places/Add/Offline/Settings), HUD, wiring
  js/nav.js                 navigation engine: GPS, compass, routing, off-route, arrival, track
  js/tiles.js               offline-first tile layer, tile providers, area downloads
  js/network.js             connection quality: offline / poor / fair / good
  js/photos.js              on-device photo compression and storage
  js/db.js                  IndexedDB wrapper (locations, photos, routes, tracks, areas, kv)
  js/geo.js                 pure maths: distance, bearing, tile ranges, corridors   (tested)
  js/importers.js           CSV / GeoJSON / export-bundle parsing                    (tested)
  data/sample-locations.json  demo places (Kisumu area)
  data/locations-template.csv template for importing site lists
  vendor/leaflet/           Leaflet 1.9.4, vendored (no CDN at runtime)
  icons/                    generated PNG icons
scripts/                    dev server, Leaflet vendoring, icon generator
tests/                      node:test unit tests
```

### Key design decisions

- **No CDN, no backend.** Everything the app needs to start is precached; all user data
  (places, photos, routes, tracks, saved-area records) lives in IndexedDB on the device.
  Teams share data by exporting/importing files.
- **Tiles are managed by the page, not the service worker.** `OfflineTileLayer` (a Leaflet
  `TileLayer` subclass in `tiles.js`) reads every tile from the Cache API first, fetches only when
  online, and when a tile is missing draws a scaled-up crop of the nearest cached lower-zoom
  "ancestor" tile. A region saved at zoom 15 therefore still renders (blurry) at zoom 18 offline.
- **Network-aware detail.** `network.js` combines `navigator.connection` (where available) with
  measured tile fetch latency/failures, taking the more pessimistic signal. In **Auto** detail mode:
  good → satellite imagery + roads + labels, with 2× tiles on high-DPI screens; fair/poor → light
  street map, and tile requests are limited to 2–4 at a time with long timeouts; offline → the
  last style used online. A style downgrade happens only after 30 s of worse signal and an upgrade
  after 8 s, so a flapping rural connection doesn't keep swapping the map.
- **Navigation degrades gracefully.** Straight-line guidance (distance, bearing, arrow from
  compass or GPS course) needs no network at all. Road routes come from the FOSSGIS OSRM servers
  (`routing.openstreetmap.de`, car/bike/foot) when online and are cached per destination, so a
  route fetched in town is reused in the field. The "last mile" from where the road ends to the
  site is drawn as a dashed line, because remote sites are often off the mapped road network.
- **Photos for recognition.** Destination photos (what the place looks like), landmark photos
  pinned at the GPS position where they were taken (shown on the map and announced when within
  150 m), and an automatic "from above" satellite view stitched from cached tiles.
- **Import pipeline with user-confirmed columns.** `importers.js` turns a file into a table
  (`readTable`), guesses column roles (`guessMapping`, including SurveyCTO `gps-Latitude` and
  combined geopoint columns), checks the chosen coordinates (`verifyCoordinates`), and builds
  records (`applyMapping`). The checks cover range, 0/0, text, whole-number "ID" columns, and
  swaps. Swaps are detected both from out-of-range values and by comparing the points' centre
  with a reference point: saved places, then GPS, then the last map view. The user always sees
  the mapping screen (`renderImportMapping` in `app.js`) for CSV/GeoJSON. The choice is remembered
  per column layout under `kv` key `mapping:<columns>`. All original columns are stored on each
  location as `fields`.
- **Search over all columns.** `searchPlaces()` in `app.js` builds a lazy per-location index of
  built-in fields plus `fields`. It supports `column:value` terms and a single-column filter.
  The index is reset in `loadLocations()`.
- **Chosen start point.** `nav.start(target, { from })` routes from `from` instead of GPS. Until
  the user first comes within range of the route (`joinedRoute`), there are no off-route
  warnings, re-routes or step advances. In that phase `nav.state()` returns `planned: true`, and
  `distance`, `bearing`, `remaining` and `eta` are measured from `from` to the destination, not
  from GPS. Only `toStart` and the arrow (`arrowBearing`/`relative`) use the live position, and the
  HUD renders this with `updatePlannedHud()`. Arrival detection always uses the real GPS distance.
  Covered by `tests/nav.test.js`.
- **Datasets (import batches).** IndexedDB v2 adds a `datasets` store. The upgrade only creates
  missing stores, so v1 data survives. Each place imported from a table carries `datasetId`.
  `saveImported(parsed, { mode })` has three modes:
  - `bundle`: an app export, matched globally.
  - `new`: creates a dataset.
  - `update`: `planDatasetUpdate()` in `importers.js` matches by code, else by name within 25 m.
    It updates matches (keeping thumb, visited and createdAt), adds new rows, and deletes
    removals if the user opted in.

  Bulk actions in the Places tab (`bulkAction()`) write with `db.putMany` / `db.delMany` in single
  transactions. `deletePlaces()` also removes photos and cached routes.
- **Nearest places panel.** `updateNearby()` runs on every GPS/heading update, throttled to 1 Hz.
  It uses `nearestPlaces()`, a single O(n) pass that keeps the best 3, and renders
  `#nearby-table`. It's hidden while a sheet is open.
- **Untrusted imports.** Import files are coerced and validated; thumbnails must be base64 image
  data URLs because they're placed into HTML attributes. All user text is escaped with `esc()`.

### Third-party services and their limits

| Service | Used for | Notes |
|---|---|---|
| tile.openstreetmap.org | Streets map | Bulk download is against the OSM tile policy. "Save area" is capped at 3,000 tiles for this style. |
| OpenTopoMap | Terrain map | Volunteer-run; same 3,000-tile cap. |
| Esri World Imagery + reference layers | Satellite, roads, labels | Check Esri's terms before large-scale or commercial use. |
| routing.openstreetmap.de | Road routing | Free, fair-use demo service. For heavy use, host your own OSRM. |
| nominatim.openstreetmap.org | Address search | Max 1 request/second; only called when the user presses Enter. |

For organisation-wide offline use, set a **custom tile server** in Settings (your own tiles,
or a commercial provider with an API key) — it has a 50,000-tile download limit.

## Conventions

- ES modules, no framework, no bundler. Keep `geo.js` and `importers.js` free of DOM so they
  stay testable in Node.
- Escape any user/imported text inserted into HTML with `esc()` in `app.js`.
- Any network call must have a timeout and a useful offline fallback.
- Add new shell files to `SHELL` in `sw.js` and bump `VERSION`.
