// Navigation engine. Works in two layers:
//  1. Always (offline too): GPS + compass -> straight-line distance, bearing and a pointing arrow.
//  2. When a road route is available (fetched online, then cached per destination): turn
//     steps, off-route detection and the "last mile" from where the road ends to the site.
import { db } from './db.js';
import { network } from './network.js';
import { distance, bearing, distanceToPolyline, compassLabel } from './geo.js';

const ROUTERS = {
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/',
  car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
};

function instruction(step) {
  const m = step.maneuver || {};
  const name = step.name ? ` onto ${step.name}` : '';
  const mod = m.modifier || '';
  switch (m.type) {
    case 'depart': return `Head ${compassLabel(m.bearing_after || 0)}${step.name ? ` on ${step.name}` : ''}`;
    case 'arrive': return 'Road ends near destination';
    case 'roundabout': case 'rotary': return `At the roundabout take exit ${m.exit || ''}${name}`.trim();
    case 'fork': return `Keep ${mod}${name}`;
    case 'merge': return `Merge ${mod}${name}`;
    case 'end of road': return `At the end of the road turn ${mod}${name}`;
    case 'new name': case 'continue': return mod && mod !== 'straight' ? `Bear ${mod}${name}` : `Continue${name}`;
    default: return mod === 'straight' ? `Continue straight${name}` : `Turn ${mod}${name}`.replace('Turn  ', 'Turn ');
  }
}

export async function fetchRoute(from, to, profile = 'car') {
  const url = `${ROUTERS[profile] || ROUTERS.car}${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), network.quality === 'poor' ? 30000 : 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Routing server error ${res.status}`);
    const data = await res.json();
    const r = data.routes?.[0];
    if (!r) throw new Error('No road route found');
    const coords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const cumulative = [0];
    for (let i = 1; i < coords.length; i++) {
      cumulative.push(cumulative[i - 1] + distance(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    }
    return {
      profile, coords, cumulative, distance: r.distance, duration: r.duration, fetchedAt: Date.now(),
      from, steps: r.legs[0].steps.map((s) => ({
        lat: s.maneuver.location[1], lng: s.maneuver.location[0], text: instruction(s), distance: s.distance,
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}

export class Navigator extends EventTarget {
  constructor() {
    super();
    this.position = null;
    this.compass = null;
    this.target = null;
    this.route = null;
    this.track = [];
    this.stepIndex = 0;
    this.arrived = false;
    this.arrivalRadius = 40;
    this.seenLandmarks = new Set();
    this.landmarks = [];
    this.offRouteSince = null;
    this.lastReroute = 0;
    this._wakeLock = null;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  watch() {
    if (!('geolocation' in navigator)) { this.emit('error', 'This device has no GPS / location support.'); return; }
    if (this._watchId != null) return;
    this._watchId = navigator.geolocation.watchPosition(
      (p) => this._onPosition(p),
      (e) => this.emit('error', e.code === 1 ? 'Location permission denied. Enable it in your browser settings.' : 'Waiting for GPS signal…'),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 60000 },
    );
  }

  /** iOS needs an explicit permission prompt from a user tap. */
  async enableCompass() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
        if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return false;
      }
    } catch { return false; }
    if (this._compassOn) return true;
    this._compassOn = true;
    const handler = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
      else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;
      if (h == null) return;
      h = (h + (screen.orientation?.angle || 0) + 360) % 360;
      // Light circular smoothing — raw magnetometer readings jitter a lot.
      if (this.compass == null) this.compass = h;
      else {
        const diff = ((h - this.compass + 540) % 360) - 180;
        this.compass = (this.compass + diff * 0.25 + 360) % 360;
      }
      this.emit('heading', this.heading);
      if (this.target) this.emit('update', this.state());
    };
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', handler);
    else window.addEventListener('deviceorientation', handler);
    return true;
  }

  /** GPS course is more reliable than the magnetometer once you're moving (e.g. in a vehicle). */
  get heading() {
    const p = this.position;
    if (p && p.speed > 1.5 && Number.isFinite(p.heading)) return p.heading;
    return this.compass;
  }

  _onPosition(pos) {
    const c = pos.coords;
    this.position = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed, time: pos.timestamp };
    this.emit('position', this.position);
    if (!this.target) return;

    const last = this.track[this.track.length - 1];
    if (!last || distance(last[0], last[1], c.latitude, c.longitude) > Math.max(8, c.accuracy / 2)) {
      this.track.push([c.latitude, c.longitude, pos.timestamp]);
      if (this.track.length % 10 === 0) this.saveTrack();
    }

    const s = this.state();
    if (!this.arrived && s.distance <= Math.max(this.arrivalRadius, Math.min(c.accuracy, 80))) {
      this.arrived = true;
      s.arrived = true;
      navigator.vibrate?.([200, 100, 200, 100, 400]);
      this.saveTrack();
      this.emit('arrived', this.target);
    }
    for (const lm of this.landmarks) {
      if (!this.seenLandmarks.has(lm.id) && lm.lat != null && distance(c.latitude, c.longitude, lm.lat, lm.lng) < 150) {
        this.seenLandmarks.add(lm.id);
        navigator.vibrate?.(150);
        this.emit('landmark', lm);
      }
    }
    if (this.route && s.offRoute && this.joinedRoute && network.online && Date.now() - this.lastReroute > 60000 &&
        this.offRouteSince && Date.now() - this.offRouteSince > 20000) {
      this.lastReroute = Date.now();
      this.from = null; // re-route from where the user actually is now
      this.loadRoute(this.route.profile, { force: true }).catch(() => {});
    }
    this.emit('update', s);
  }

  state() {
    const p = this.position, t = this.target;
    if (!t) return { hasFix: !!p, target: t };
    if (!p) {
      const r = this.route;
      const end = r?.coords[r.coords.length - 1];
      return { hasFix: false, target: t, route: r, lastMile: end ? distance(end[0], end[1], t.lat, t.lng) : 0 };
    }
    const dist = distance(p.lat, p.lng, t.lat, t.lng);
    const brg = bearing(p.lat, p.lng, t.lat, t.lng);
    const out = {
      hasFix: true, target: t, distance: dist, bearing: brg, bearingLabel: compassLabel(brg),
      heading: this.heading, relative: this.heading == null ? null : (brg - this.heading + 360) % 360,
      accuracy: p.accuracy, arrived: this.arrived, route: this.route,
    };
    const r = this.route;
    if (r) {
      const off = distanceToPolyline(p.lat, p.lng, r.coords);
      const threshold = Math.max(70, p.accuracy * 1.5);
      // A route planned from another start point only "begins" once the user reaches it.
      if (!this.joinedRoute && off <= threshold) this.joinedRoute = true;
      out.offRoute = this.joinedRoute && off > threshold;
      if (!this.joinedRoute) {
        out.notJoined = true;
        out.toStart = distance(p.lat, p.lng, r.coords[0][0], r.coords[0][1]);
        out.toStartLabel = compassLabel(bearing(p.lat, p.lng, r.coords[0][0], r.coords[0][1]));
      }
      if (out.offRoute) this.offRouteSince ??= Date.now(); else this.offRouteSince = null;
      // Remaining distance along the route from the nearest vertex.
      let nearest = 0, best = Infinity;
      for (let i = 0; i < r.coords.length; i++) {
        const d = distance(p.lat, p.lng, r.coords[i][0], r.coords[i][1]);
        if (d < best) { best = d; nearest = i; }
      }
      const end = r.coords[r.coords.length - 1];
      out.lastMile = distance(end[0], end[1], t.lat, t.lng);
      out.remaining = r.cumulative[r.cumulative.length - 1] - r.cumulative[nearest] + out.lastMile;
      while (this.joinedRoute && this.stepIndex < r.steps.length - 1) {
        const st = r.steps[this.stepIndex];
        const passed = r.coords.findIndex((c) => c[0] === st.lat && c[1] === st.lng);
        if (distance(p.lat, p.lng, st.lat, st.lng) < Math.max(25, p.accuracy) || (passed >= 0 && passed < nearest)) this.stepIndex++;
        else break;
      }
      const step = r.steps[this.stepIndex];
      if (step) out.nextStep = { text: step.text, distance: distance(p.lat, p.lng, step.lat, step.lng) };
      out.onRoad = best < 60 && nearest < r.coords.length - 2;
    } else out.remaining = dist;
    const speed = p.speed > 0.5 ? p.speed : null;
    if (speed) out.eta = out.remaining / speed;
    else if (r && r.distance > 0) out.eta = r.duration * (out.remaining / (r.distance + (out.lastMile || 0)));
    return out;
  }

  async start(target, { profile = 'car', landmarks = [], from = null } = {}) {
    this.target = target;
    this.from = from;
    this.joinedRoute = !from;
    this.arrived = false;
    this.stepIndex = 0;
    this.route = null;
    this.landmarks = landmarks;
    this.seenLandmarks = new Set();
    this.track = this.position ? [[this.position.lat, this.position.lng, Date.now()]] : [];
    this.watch();
    this._requestWakeLock();
    this.emit('started', target);
    await this.loadRoute(profile).catch((e) => this.emit('route-error', e.message));
    this.emit('update', this.state());
  }

  async loadRoute(profile, { force = false } = {}) {
    const t = this.target;
    if (!t) return;
    const cached = t.id ? await db.get('routes', t.id) : null;
    // Route from the chosen start point if there is one, otherwise from the live GPS position.
    const origin = this.from || this.position;
    const cacheUsable = cached && cached.profile === profile && (!origin || distance(origin.lat, origin.lng, cached.from.lat, cached.from.lng) < 2000);
    if (!force && cacheUsable) { this._setRoute(cached.route, true); return; }
    if (!network.online || !origin) {
      if (cached && cached.profile === profile) this._setRoute(cached.route, true);
      else this.emit('route-error', network.online ? 'Waiting for GPS before fetching a road route' : 'Offline: using compass guidance');
      return;
    }
    const route = await fetchRoute(origin, t, profile);
    if (t.id) await db.put('routes', { locationId: t.id, profile, from: { lat: origin.lat, lng: origin.lng, name: this.from?.name || '' }, route });
    this._setRoute(route, false);
  }

  _setRoute(route, fromCache) {
    this.route = route;
    this.stepIndex = 0;
    this.emit('route', { route, fromCache });
  }

  stop() {
    this.saveTrack();
    this.target = null;
    this.route = null;
    this.from = null;
    this.landmarks = [];
    this._wakeLock?.release?.().catch(() => {});
    this._wakeLock = null;
    this.emit('stopped');
  }

  async saveTrack() {
    if (this.track.length < 2) return;
    this._trackId ??= `track-${Date.now()}`;
    await db.put('tracks', { id: this._trackId, target: this.target?.name || '', points: this.track, savedAt: Date.now() });
  }

  async _requestWakeLock() {
    // The browser drops the wake lock whenever the app is backgrounded; re-take it on return.
    if (!this._visibilityHooked) {
      this._visibilityHooked = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.target) this._requestWakeLock();
      });
    }
    try {
      this._wakeLock = await navigator.wakeLock?.request('screen');
    } catch { /* not supported or denied: screen may sleep */ }
  }
}

export function trackToGpx(track) {
  const pts = track.points.map(([lat, lng, t]) => `<trkpt lat="${lat}" lon="${lng}"><time>${new Date(t).toISOString()}</time></trkpt>`).join('');
  const name = String(track.target || 'Track').replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Field Navigator" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}
