// The globe's geometry, iter20 m7.
//
// three.js draws it; none of this needs three.js. A click that lands on
// Germany must land on Germany with no renderer present, so all of it is
// checked here rather than by looking at a picture and deciding it seems fine
// — which is how a globe with its markers mirrored east-west ships.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toVector, toLatLon, arcPoints, countryAt, nearestCountry }
  from '../../frontend/src/lib/globeGeo.js';

const COUNTRIES = JSON.parse(readFileSync(
  new URL('../../frontend/src/assets/countries.json', import.meta.url), 'utf8'));

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('\nTHE PROJECTION IS ITS OWN INVERSE:');

check('every place comes back as itself', () => {
  // The check that catches a mirrored globe. Markers on the wrong side of the
  // world look almost right on a map you are not from.
  for (const [lat, lon] of [[0, 0], [55.75, 37.62], [-33.87, 151.21], [51.5, -0.13],
                            [89, 179], [-89, -179], [0, 180], [0, -180]]) {
    const back = toLatLon(toVector(lat, lon));
    assert.ok(near(back.lat, lat, 1e-6), `lat ${lat} -> ${back.lat}`);
    // Wrapped difference, so -180 and 180 count as the same meridian. The
    // first version of this line compared the wrapped value against 180
    // instead of zero and failed on the equator at the prime meridian — the
    // one place on earth where every coordinate is 0 and nothing can be wrong.
    const dlon = ((back.lon - lon + 540) % 360) - 180;
    assert.ok(Math.abs(dlon) < 1e-6, `lon ${lon} -> ${back.lon}`);
  }
});

check('the poles are the poles', () => {
  assert.ok(near(toVector(90, 0).y, 1));
  assert.ok(near(toVector(-90, 0).y, -1));
});

check('east and west are not swapped', () => {
  // Moscow and London are on opposite sides of the prime meridian; if the sign
  // convention flips, everything still renders and every marker is wrong.
  const msk = toVector(55.75, 37.62);
  const lon = toVector(51.5, -0.13);
  assert.notEqual(Math.sign(msk.z), Math.sign(lon.z));
});

console.log('\nARCS FOLLOW THE SPHERE:');

check('an arc starts and ends on its endpoints', () => {
  const a = { lat: 55.75, lon: 37.62 }, b = { lat: 52.37, lon: 4.9 };
  const pts = arcPoints(a, b, { segments: 32 });
  const p0 = toVector(a.lat, a.lon), p1 = toVector(b.lat, b.lon);
  for (const k of ['x', 'y', 'z']) {
    assert.ok(near(pts[0][k], p0[k], 1e-3), `start ${k}`);
    assert.ok(near(pts[pts.length - 1][k], p1[k], 1e-3), `end ${k}`);
  }
});

check('an arc never dips inside the planet', () => {
  // A straight line between two vectors cuts through the globe. It looks like
  // a tunnel because it is one.
  const pts = arcPoints({ lat: 55.75, lon: 37.62 }, { lat: -33.87, lon: 151.21 }, { segments: 64 });
  for (const p of pts) {
    const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    assert.ok(r >= 0.999, `radius dipped to ${r.toFixed(4)}`);
  }
});

check('a long arc rises higher than a short one', () => {
  const high = (a, b) => Math.max(...arcPoints(a, b).map(p => Math.hypot(p.x, p.y, p.z)));
  const shortHop = high({ lat: 52.5, lon: 13.4 }, { lat: 50.1, lon: 8.7 });
  const longHaul = high({ lat: 55.75, lon: 37.62 }, { lat: -33.87, lon: 151.21 });
  assert.ok(longHaul > shortHop, 'arc height does not scale with distance');
});

check('two points in the same place do not produce NaN', () => {
  const pts = arcPoints({ lat: 10, lon: 20 }, { lat: 10, lon: 20 }, { segments: 8 });
  assert.ok(pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)));
});

console.log('\nA CLICK LANDS WHERE IT LANDS:');

check('capitals are in their own countries', () => {
  const cases = [[52.52, 13.40, 'DE'], [55.75, 37.62, 'RU'], [48.86, 2.35, 'FR'],
                 [51.51, -0.13, 'GB'], [40.71, -74.01, 'US'], [35.68, 139.75, 'JP'],
                 [-23.55, -46.63, 'BR'], [-33.87, 151.21, 'AU'], [-1.29, 36.82, 'KE']];
  for (const [lat, lon, cc] of cases) {
    const hit = countryAt(lon, lat, COUNTRIES);
    assert.equal(hit?.cc, cc, `${lat},${lon} -> ${hit?.cc || 'nothing'}`);
  }
});

check('a click across the antimeridian is not nonsense', () => {
  // Russia and Fiji both have rings spanning the whole longitude range. Ray
  // casting on them unshifted answers gibberish, and the gibberish is
  // plausible: a click in Kamchatka landing somewhere in the Atlantic.
  const kamchatka = countryAt(159.0, 56.0, COUNTRIES);
  assert.equal(kamchatka?.cc, 'RU');
});

check('the middle of an ocean is nobody\'s', () => {
  // Rather than the nearest coast, silently.
  assert.equal(countryAt(-30, 0, COUNTRIES), null);
});

check('micro-states are absent at this scale, and that is stated not hidden', () => {
  // 110m Natural Earth omits Singapore, Malta, Monaco, Liechtenstein and
  // Andorra entirely — they are smaller than the simplification tolerance. A
  // click on Singapore therefore names Malaysia.
  //
  // Asserted rather than worked around: the alternative is 10m data at roughly
  // ten times the size for a globe whose job is to show fourteen servers, and
  // silently naming a neighbour is only acceptable if the panel says it may.
  assert.equal(COUNTRIES.some(f => f.cc === 'SG'), false);
  assert.equal(countryAt(103.82, 1.35, COUNTRIES)?.cc, 'MY');
});

check('a sea click still gets a nearest country, separately', () => {
  const n = nearestCountry(4.0, 54.5, COUNTRIES);   // North Sea
  assert.ok(['NL', 'GB', 'DE', 'DK', 'BE'].includes(n?.cc), `got ${n?.cc}`);
});

console.log('\nTHE DATASET:');

check('every country carries an ISO code and geometry', () => {
  assert.ok(COUNTRIES.length > 150, `only ${COUNTRIES.length} countries`);
  for (const f of COUNTRIES) {
    assert.match(f.cc, /^[A-Z]{2}$/, `bad code ${f.cc}`);
    assert.ok(f.p.length && f.p[0][0].length >= 4, `${f.cc} has no usable ring`);
  }
});

check('the fleet\'s own countries are present', () => {
  for (const cc of ['RU', 'DE', 'NL', 'FI', 'BE', 'IE', 'SE', 'FR', 'US', 'JP']) {
    assert.ok(COUNTRIES.some(f => f.cc === cc), `${cc} is missing`);
  }
});

console.log('\nTHE GLOBE COSTS ONLY THE TAB IT IS ON:');

const readFile = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const panel = readFile('../../frontend/src/components/DeliveryNetworkPanel.jsx');
const globe = readFile('../../frontend/src/components/GlobePanel.jsx');

check('the globe is loaded lazily, data and all', () => {
  // three.js is comparable in size to the rest of the bundle put together, and
  // the country polygons are another 155 kB. Imported statically they land in
  // the main chunk and every page pays for a globe on one tab of one page.
  assert.ok(/lazy\(\(\) => import\('\.\/GlobePanel\.jsx'\)\)/.test(panel),
    'the globe tab is imported statically');
  assert.ok(!/^import GlobePanel/m.test(panel), 'the globe is also imported eagerly');
  assert.ok(/await import\('three'\)/.test(globe), 'three.js is not loaded on demand');
});

check('a browser without WebGL is told, not shown a blank rectangle', () => {
  assert.ok(/globe\.noWebgl/.test(globe));
});

check('a node with no coordinates is listed, not placed at zero', () => {
  // 0,0 is in the Atlantic. A marker nobody can account for is worse than a
  // marker missing.
  assert.ok(/unplaced/.test(globe), 'unplaced nodes are not surfaced');
  assert.ok(/Number\.isFinite\(x\.s\.geo\?\.lat\)/.test(globe),
    'coordinates are not checked before placing a marker');
});

check('the licences the data carries are on the page that shows it', () => {
  assert.ok(/naturalearthdata\.com/.test(globe));
  assert.ok(/db-ip\.com/.test(globe), 'DB-IP results are shown without its required link');
});

console.log(failures ? `\n${failures} globe-geometry check(s) failed` : '\nall globe-geometry checks passed');
process.exit(failures ? 1 : 0);
