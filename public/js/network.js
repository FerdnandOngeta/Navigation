// Classifies the connection as offline / poor / fair / good so the app can decide
// how much map detail to request. Combines the Network Information API (Chrome/Android)
// with what we actually measure while downloading tiles, because the API is absent on
// iOS and often optimistic on congested rural towers.

const listeners = new Set();
const samples = []; // recent tile fetch timings: { ms, ok }
let current = null;

function fromApi() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return null;
  if (c.saveData) return 'poor';
  if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g') return 'poor';
  if (c.effectiveType === '3g') return 'fair';
  if (typeof c.downlink === 'number' && c.downlink > 0 && c.downlink < 0.7) return 'poor';
  return 'good';
}

function fromSamples() {
  const recent = samples.slice(-12);
  if (recent.length < 4) return null;
  const failRate = recent.filter((s) => !s.ok).length / recent.length;
  const ok = recent.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  const median = ok.length ? ok[Math.floor(ok.length / 2)] : Infinity;
  // Generous thresholds: the map fires many tile requests at once, which inflates timings
  // even on a healthy link.
  if (failRate > 0.5 || median > 6000) return 'poor';
  if (failRate > 0.25 || median > 2500) return 'fair';
  return 'good';
}

const rank = { offline: 0, poor: 1, fair: 2, good: 3 };

function compute() {
  if (!navigator.onLine) return 'offline';
  const api = fromApi();
  const measured = fromSamples();
  // Trust the more pessimistic of the two signals.
  const candidates = [api, measured].filter(Boolean);
  if (!candidates.length) return 'fair';
  return candidates.reduce((a, b) => (rank[a] <= rank[b] ? a : b));
}

function update() {
  const next = compute();
  if (next !== current) {
    current = next;
    listeners.forEach((fn) => fn(current));
  }
}

export const network = {
  get quality() { return current ?? compute(); },
  get online() { return this.quality !== 'offline'; },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  /** Called by the tile loader after each network fetch. */
  record(ms, ok) {
    samples.push({ ms, ok });
    if (samples.length > 40) samples.shift();
    update();
  },
  init() {
    window.addEventListener('online', () => { samples.length = 0; update(); });
    window.addEventListener('offline', update);
    navigator.connection?.addEventListener?.('change', update);
    update();
  },
};
