// Photos are compressed on-device before saving: phone cameras produce 3–8 MB images,
// which would fill storage quickly and make sharing location packs over weak links painful.
import { db, uid } from './db.js';

async function resize(file, maxSide, quality) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

export async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

/**
 * kind: 'destination' (what the place looks like) or 'landmark' (something you pass en route,
 * pinned where the photo was taken).
 */
export async function savePhoto(file, { locationId, kind = 'destination', caption = '', lat = null, lng = null }) {
  const [blob, thumbBlob] = await Promise.all([resize(file, 1280, 0.72), resize(file, 160, 0.7)]);
  const photo = {
    id: uid(), locationId, kind, caption, lat, lng,
    blob, thumb: await blobToDataUrl(thumbBlob), takenAt: Date.now(),
  };
  await db.put('photos', photo);
  return photo;
}

export async function photoFromUrl(url, opts) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return savePhoto(await res.blob(), opts);
}

export const photosFor = (locationId) => db.byIndex('photos', 'locationId', locationId);

export async function photoToExport(p) {
  return { ...p, blob: await blobToDataUrl(p.blob) };
}

export async function photoFromExport(p) {
  return { ...p, blob: typeof p.blob === 'string' ? await dataUrlToBlob(p.blob) : p.blob };
}

const urlCache = new Map();
/** Object URLs are reused so re-rendering a list doesn't leak memory. */
export function photoUrl(photo) {
  if (!urlCache.has(photo.id)) urlCache.set(photo.id, URL.createObjectURL(photo.blob));
  return urlCache.get(photo.id);
}
export function forgetPhotoUrl(id) {
  const u = urlCache.get(id);
  if (u) { URL.revokeObjectURL(u); urlCache.delete(id); }
}
