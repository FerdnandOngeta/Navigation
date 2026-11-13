import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distance, bearing, compassLabel, formatDistance, distanceToPolyline,
  lngToTileX, latToTileY, countTiles, tilesInBounds, corridorTiles, parseCoordinates, boundsAround,
} from '../public/js/geo.js';
import {
  parseCSV, parseImport, readTable, guessMapping, verifyCoordinates, applyMapping, parseCoordValue, parseCombined,
  planDatasetUpdate, nearestPlaces,
} from '../public/js/importers.js';

test('distance: one degree of latitude is ~111 km', () => {
  assert.ok(Math.abs(distance(0, 36, 1, 36) - 111195) < 50);
});

test('bearing: due east and due north', () => {
  assert.ok(Math.abs(bearing(0, 0, 0, 1) - 90) < 1e-6);
  assert.ok(Math.abs(bearing(0, 0, 1, 0) - 0) < 1e-6);
  assert.equal(compassLabel(90), 'E');
  assert.equal(compassLabel(359), 'N');
});

test('formatDistance', () => {
  assert.equal(formatDistance(420), '420 m');
  assert.equal(formatDistance(2345), '2.3 km');
  assert.equal(formatDistance(23456), '23 km');
});

test('distanceToPolyline: point beside a segment', () => {
  const line = [[0, 0], [0, 1]];
  const d = distanceToPolyline(0.001, 0.5, line);
  assert.ok(Math.abs(d - 111.2) < 1, `got ${d}`);
});

test('tile maths matches known values', () => {
  // Nairobi at z10
  assert.equal(lngToTileX(36.8219, 10), 616);
  assert.equal(latToTileY(-1.2921, 10), 515);
  assert.equal(countTiles({ south: -1, north: -1, west: 36, east: 36 }, 5, 7), 3);
  const tiles = [...tilesInBounds(boundsAround(-1.29, 36.82, 500), 14, 15)];
  assert.equal(tiles.length, countTiles(boundsAround(-1.29, 36.82, 500), 14, 15));
});

test('corridorTiles returns unique tiles', () => {
  const t = corridorTiles([[-1.29, 36.82], [-1.20, 36.90]], 200, 12, 13);
  const keys = new Set(t.map((x) => `${x.z}/${x.x}/${x.y}`));
  assert.equal(keys.size, t.length);
  assert.ok(t.length > 2);
});

test('parseCoordinates', () => {
  assert.deepEqual(parseCoordinates('-1.2921, 36.8219'), { lat: -1.2921, lng: 36.8219 });
  assert.equal(parseCoordinates('Kisumu'), null);
  assert.equal(parseCoordinates('95, 10'), null);
});

test('parseCSV handles quotes, commas and CRLF', () => {
  const rows = parseCSV('name,notes\r\n"Site, A","He said ""hi"""\r\n');
  assert.deepEqual(rows, [['name', 'notes'], ['Site, A', 'He said "hi"']]);
});

test('parseImport: CSV with alternative headers', () => {
  const r = parseImport('Site_Name,Latitude,Longitude\nAlpha,-0.1,34.7\nBad,,\n', 'x.csv');
  assert.equal(r.locations.length, 1);
  assert.equal(r.locations[0].name, 'Alpha');
  assert.equal(r.skipped, 1);
});

test('parseImport: Field Navigator export bundle passes through', () => {
  const bundle = JSON.stringify({ app: 'field-navigator', version: 1, locations: [{ id: 'a', name: 'A', lat: 1, lng: 2 }], photos: [{ id: 'p' }] });
  const r = parseImport(bundle, 'places.json');
  assert.equal(r.locations.length, 1);
  assert.equal(r.photos.length, 1);
});

test('parseImport: GeoJSON points', () => {
  const gj = JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [34.7, -0.1] }, properties: { name: 'P' } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
  ] });
  const r = parseImport(gj, 'x.geojson');
  assert.equal(r.locations.length, 1);
  assert.equal(r.locations[0].lat, -0.1);
  assert.equal(r.skipped, 1);
});

test('parseCoordValue: decimal, decimal comma and DMS', () => {
  assert.equal(parseCoordValue('-0.0917'), -0.0917);
  assert.equal(parseCoordValue('34,768'), 34.768);
  assert.ok(Math.abs(parseCoordValue(`0°05'30"S`) - -0.091667) < 1e-5);
  assert.ok(Math.abs(parseCoordValue('34 46 4.8 E') - 34.768) < 1e-5);
  assert.ok(Number.isNaN(parseCoordValue('Kisumu')));
  assert.ok(Number.isNaN(parseCoordValue('')));
});

test('parseCombined: SurveyCTO geopoint "lat lng alt acc"', () => {
  assert.deepEqual(parseCombined('-0.0917 34.768 1150 4.5'), { lat: -0.0917, lng: 34.768 });
});

test('guessMapping: SurveyCTO-style gps-Latitude columns and name/code', () => {
  const t = readTable('KEY,school_name,gps-Latitude,gps-Longitude,gps-Altitude,district\nuuid:1,Alpha,-0.1,34.7,1100,Kisumu\n', 'x.csv');
  const m = guessMapping(t.columns, t.rows);
  assert.equal(m.lat, 'gps-Latitude');
  assert.equal(m.lng, 'gps-Longitude');
  assert.equal(m.name, 'school_name');
  assert.equal(m.code, 'KEY');
});

test('guessMapping: combined geopoint column', () => {
  const t = readTable('hh_id,gps\n1,-0.1 34.7 1100 5\n2,-0.2 34.8 1100 5\n', 'x.csv');
  const m = guessMapping(t.columns, t.rows);
  assert.equal(m.mode, 'combined');
  assert.equal(m.combined, 'gps');
  assert.equal(applyMapping(t.rows, m).locations.length, 2);
});

test('guessMapping: unclear headers leave coordinates unset', () => {
  const t = readTable('a,b,c\nX,-0.1,34.7\n', 'x.csv');
  const m = guessMapping(t.columns, t.rows);
  assert.equal(m.lat, '');
  assert.equal(verifyCoordinates(t.rows, m).verdict, 'bad');
  const v = verifyCoordinates(t.rows, { ...m, lat: 'b', lng: 'c' });
  assert.equal(v.verdict, 'ok');
  assert.equal(v.valid, 1);
});

test('verifyCoordinates: flags swapped columns, IDs and zeros', () => {
  const rows = [{ la: '34.7', lo: '-0.1' }, { la: '34.8', lo: '-0.2' }, { la: '0', lo: '0' }];
  const swapped = verifyCoordinates(rows, { mode: 'separate', lat: 'lo', lng: 'la' });
  assert.equal(swapped.valid, 2);
  const ids = verifyCoordinates([{ a: '1', b: '2' }, { a: '3', b: '4' }, { a: '5', b: '6' }], { mode: 'separate', lat: 'a', lng: 'b' });
  assert.equal(ids.verdict, 'bad');
  assert.ok(ids.messages.some((m) => /IDs/.test(m)));
  const outOfRange = verifyCoordinates([{ a: '120.5', b: '-0.1' }, { a: '121.2', b: '-0.2' }], { mode: 'separate', lat: 'a', lng: 'b' });
  assert.ok(outOfRange.messages.some((m) => /swapped/.test(m)));
  const fixed = verifyCoordinates([{ a: '120.5', b: '-0.1' }], { mode: 'separate', lat: 'a', lng: 'b', swap: true });
  assert.equal(fixed.valid, 1);
});

test('applyMapping keeps every original column in fields', () => {
  const t = readTable('name;lat;lon;district;ward\nAlpha;-0,1;34,7;Kisumu;Kolwa\n', 'x.csv');
  const { locations } = applyMapping(t.rows, guessMapping(t.columns, t.rows));
  assert.equal(locations[0].lat, -0.1);
  assert.equal(locations[0].fields.district, 'Kisumu');
  assert.equal(locations[0].fields.ward, 'Kolwa');
});

test('verifyCoordinates: in-range but swapped is caught using a reference point', () => {
  const rows = [{ a: '34.70', b: '-0.08' }, { a: '34.81', b: '-0.06' }];
  const kisumu = { lat: -0.09, lng: 34.76 };
  const v = verifyCoordinates(rows, { mode: 'separate', lat: 'a', lng: 'b' }, { near: kisumu, nearLabel: 'x' });
  assert.equal(v.verdict, 'warn');
  assert.equal(v.swapSuggested, true);
  const ok = verifyCoordinates(rows, { mode: 'separate', lat: 'b', lng: 'a' }, { near: kisumu });
  assert.equal(ok.verdict, 'ok');
});

test('verifyCoordinates: ID column in latitude is called out as IDs, not a swap', () => {
  const rows = [{ id: '101', y: '-0.08' }, { id: '102', y: '-0.06' }, { id: '103', y: '-0.07' }];
  const v = verifyCoordinates(rows, { mode: 'separate', lat: 'id', lng: 'y' });
  assert.equal(v.verdict, 'bad');
  assert.equal(v.swapSuggested, false);
  assert.ok(v.messages.some((m) => /IDs/.test(m)));
});

test('planDatasetUpdate: matches by code, falls back to name+location, finds removals', () => {
  const existing = [
    { id: 'a', code: 'S1', name: 'Alpha', lat: -0.1, lng: 34.7 },
    { id: 'b', code: '', name: 'Bravo', lat: -0.2, lng: 34.8 },
    { id: 'c', code: 'S3', name: 'Charlie', lat: -0.3, lng: 34.9 },
  ];
  const incoming = [
    { code: 's1', name: 'Alpha renamed', lat: -0.1001, lng: 34.7 },
    { code: '', name: 'Bravo', lat: -0.20005, lng: 34.8 },
    { code: 'S9', name: 'New', lat: -0.4, lng: 35 },
  ];
  const plan = planDatasetUpdate(existing, incoming);
  assert.deepEqual(plan.updates.map((u) => u.existing.id), ['a', 'b']);
  assert.equal(plan.adds.length, 1);
  assert.deepEqual(plan.removals.map((r) => r.id), ['c']);
});

test('nearestPlaces returns the 3 closest, nearest first', () => {
  const places = [0.5, 0.1, 0.3, 0.05, 0.2].map((d, i) => ({ id: String(i), lat: d, lng: 0 }));
  const r = nearestPlaces(places, 0, 0, 3);
  assert.deepEqual(r.map((x) => x.place.id), ['3', '1', '4']);
  assert.ok(r[0].d < r[1].d && r[1].d < r[2].d);
});
