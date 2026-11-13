import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Navigator } from '../public/js/nav.js';
import { distance } from '../public/js/geo.js';

const office = { name: 'Office', lat: -0.1010, lng: 34.7520 };
const school = { id: 's', name: 'School', lat: -0.0420, lng: 34.8890 };
const user = { lat: -0.0650, lng: 34.7300, accuracy: 8, speed: 0, heading: null };

function planned() {
  const n = new Navigator();
  n.target = school;
  n.from = office;
  n.joinedRoute = false;
  n.position = { ...user };
  return n;
}

test('planned trip: distance and bearing are measured from the chosen start, not the user', () => {
  const s = planned().state();
  assert.equal(s.planned, true);
  const fromStart = distance(office.lat, office.lng, school.lat, school.lng);
  const fromUser = distance(user.lat, user.lng, school.lat, school.lng);
  assert.ok(Math.abs(s.distance - fromStart) < 1);
  assert.ok(Math.abs(s.distance - fromUser) > 1000, 'must not be the distance from the user');
  assert.equal(s.remaining, s.distance); // no road route: straight line
  // The user is still told how far the start point is.
  assert.ok(Math.abs(s.toStart - distance(user.lat, user.lng, office.lat, office.lng)) < 1);
});

test('planned trip with a road route: remaining = whole route from the start + last mile', () => {
  const n = planned();
  const coords = [[office.lat, office.lng], [-0.07, 34.82], [-0.0425, 34.8885]];
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) cumulative.push(cumulative[i - 1] + distance(...coords[i - 1], ...coords[i]));
  n.route = { coords, cumulative, distance: cumulative[2], duration: 1200, steps: [] };
  const s = n.state();
  const lastMile = distance(-0.0425, 34.8885, school.lat, school.lng);
  assert.ok(Math.abs(s.remaining - (cumulative[2] + lastMile)) < 1);
  assert.ok(s.eta >= 1200);
});

test('once the user reaches the start, figures switch to live from the GPS position', () => {
  const n = planned();
  n.position = { ...user, lat: office.lat, lng: office.lng };
  const s = n.state();
  assert.equal(s.planned, undefined);
  assert.equal(n.joinedRoute, true);
  assert.ok(Math.abs(s.distance - distance(office.lat, office.lng, school.lat, school.lng)) < 1);
});

test('without a chosen start, distance is from the user', () => {
  const n = new Navigator();
  n.target = school;
  n.joinedRoute = true;
  n.position = { ...user };
  const s = n.state();
  assert.ok(Math.abs(s.distance - distance(user.lat, user.lng, school.lat, school.lng)) < 1);
});
