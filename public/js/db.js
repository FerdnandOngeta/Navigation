// Tiny promise wrapper around IndexedDB. Everything the user creates lives on the device.

const DB_NAME = 'field-navigator';
const DB_VERSION = 2; // v2: 'datasets' store (each import batch)
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      // Create only what's missing, so upgrading an installed app keeps the user's data.
      const db = req.result;
      const has = (n) => db.objectStoreNames.contains(n);
      if (!has('locations')) db.createObjectStore('locations', { keyPath: 'id' });
      if (!has('photos')) db.createObjectStore('photos', { keyPath: 'id' }).createIndex('locationId', 'locationId');
      if (!has('routes')) db.createObjectStore('routes', { keyPath: 'locationId' });
      if (!has('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
      if (!has('areas')) db.createObjectStore('areas', { keyPath: 'id' });
      if (!has('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      if (!has('datasets')) db.createObjectStore('datasets', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const db = {
  get: async (s, key) => wrap((await store(s)).get(key)),
  all: async (s) => wrap((await store(s)).getAll()),
  put: async (s, value) => wrap((await store(s, 'readwrite')).put(value)),
  del: async (s, key) => wrap((await store(s, 'readwrite')).delete(key)),
  clear: async (s) => wrap((await store(s, 'readwrite')).clear()),
  byIndex: async (s, index, value) => wrap((await store(s)).index(index).getAll(value)),
  /** Write many records in one transaction (much faster for imports). */
  putMany: async (s, values) => {
    const tx = (await open()).transaction(s, 'readwrite');
    const os = tx.objectStore(s);
    values.forEach((v) => os.put(v));
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  },
  delMany: async (s, keys) => {
    const tx = (await open()).transaction(s, 'readwrite');
    const os = tx.objectStore(s);
    keys.forEach((k) => os.delete(k));
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  },
};

export async function getSetting(key, fallback) {
  const row = await db.get('kv', key);
  return row ? row.value : fallback;
}
export const setSetting = (key, value) => db.put('kv', { key, value });

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
