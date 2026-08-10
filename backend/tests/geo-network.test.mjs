// The geolocation layer and the delivery-network topology, iter20 m1.
//
// The download is the one part that touches the internet, so every rule around
// it is exercised here with a fake fetch: which release is tried and in what
// order, what a 404 means on the 1st of the month, what happens to a body that
// lies about its size, and what is left on disk when a download fails. None of
// that needs a network to be wrong, so none of it needs one to be tested.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'geoip');

// GEOIP_DIR is read at import time by the service, so it is set first.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'nnm-geoip-'));
process.env.GEOIP_DIR = TMP;

const geoip = await import('../src/services/geoip.js');
const { downloadEdition } = await import('../src/services/geoipUpdate.js');
const { validateNodes } = await import('../src/routes/cdnNetworks.js');
const { ROLES, ALLOWED_UPSTREAM } = await import('../src/models/DeliveryNetwork.js');

let failures = 0;
const check = (name, fn) => {
  try { const r = fn(); if (r instanceof Promise) return r.then(
    () => console.log(`  ✓ ${name}`),
    e => { console.log(`  ✗ ${name}: ${e.message}`); failures++; }); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const countryFixture = await fs.readFile(path.join(FIXTURES, 'GeoLite2-Country-Test.mmdb'));
const cityFixture = await fs.readFile(path.join(FIXTURES, 'GeoLite2-City-Test.mmdb'));

// A fake fetch that serves whichever releases it was told exist.
const fakeFetch = (available, body = countryFixture) => async (url) => {
  const hit = available.find(r => url.includes(r));
  if (!hit) return { ok: false, status: 404, headers: { get: () => null } };
  const gz = gzipSync(body);
  return {
    ok: true, status: 200,
    headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(gz.length) : null) },
    body: gz,
  };
};

console.log('\nTHE DOWNLOAD URL IS BUILT, NOT GUESSED:');

check('the URL matches the one shape db-ip.com serves', () => {
  assert.equal(geoip.downloadUrl('country', 2026, 8),
    'https://download.db-ip.com/free/dbip-country-lite-2026-08.mmdb.gz');
  assert.equal(geoip.downloadUrl('city', 2026, 1),
    'https://download.db-ip.com/free/dbip-city-lite-2026-01.mmdb.gz');
});

check('a release published on the 1st is not assumed to exist yet', () => {
  // Releases go out on the 1st. A panel started that morning must fall back to
  // last month rather than report the database missing.
  const c = geoip.candidateReleases(new Date('2026-03-01T04:00:00Z'), 3);
  assert.deepEqual(c, [{ year: 2026, month: 3 }, { year: 2026, month: 2 }, { year: 2026, month: 1 }]);
});

check('the fallback crosses a year boundary', () => {
  const c = geoip.candidateReleases(new Date('2026-01-15T00:00:00Z'), 3);
  assert.deepEqual(c, [{ year: 2026, month: 1 }, { year: 2025, month: 12 }, { year: 2025, month: 11 }]);
});

console.log('\nDOWNLOADING, WITHOUT A NETWORK:');

await check('the current release is installed when it exists', async () => {
  const r = await downloadEdition('country', {
    fetchImpl: fakeFetch(['2026-08']), now: new Date('2026-08-20T00:00:00Z'),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.release, '2026-08');
  const st = await geoip.status();
  assert.equal(st.present, true);
  assert.equal(st.edition, 'country');
});

await check('a missing current release falls back to the previous month', async () => {
  const r = await downloadEdition('country', {
    fetchImpl: fakeFetch(['2026-07']), now: new Date('2026-08-01T02:00:00Z'),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.release, '2026-07');
  assert.equal(r.tried.length, 1, 'August was tried and 404ed before July was fetched');
  assert.equal(r.tried[0].status, 404);
});

await check('a body that lies about its length is cut off, not written out', async () => {
  // content-length is a claim. The ceiling is enforced again while streaming,
  // because the alternative is a panel filling its own volume.
  const huge = Buffer.alloc(40e6, 7);
  const lying = async () => ({
    ok: true, status: 200,
    headers: { get: (h) => (h.toLowerCase() === 'content-length' ? '1000' : null) },
    body: gzipSync(huge),
  });
  const r = await downloadEdition('country', { fetchImpl: lying, now: new Date('2026-08-20T00:00:00Z') });
  assert.equal(r.ok, false);
  assert.match(r.error, /exceeded/);
});

await check('a failed download leaves no partial file behind', async () => {
  const left = (await fs.readdir(TMP)).filter(f => f.startsWith('.incoming-'));
  assert.deepEqual(left, [], `left behind: ${left.join(', ')}`);
});

await check('a working database survives a failed update', async () => {
  // The previous release was installed above; the lying fetch must not have
  // taken it away. A failed update leaving no database at all is worse than
  // an update that did not happen.
  const st = await geoip.status();
  assert.equal(st.present, true);
  assert.equal(st.release, '2026-07');
});

await check('a download that is not a database is refused before installation', async () => {
  const junk = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: gzipSync(Buffer.from('this gunzips perfectly and is not a database')),
  });
  const r = await downloadEdition('country', { fetchImpl: junk, now: new Date('2026-08-20T00:00:00Z') });
  assert.equal(r.ok, false);
  const st = await geoip.status();
  assert.equal(st.release, '2026-07', 'the working database is still the one installed');
});

console.log('\nLOOKUPS:');

await check('an address resolves to a country', async () => {
  await downloadEdition('country', { fetchImpl: fakeFetch(['2026-08']), now: new Date('2026-08-20T00:00:00Z') });
  const r = await geoip.lookup('89.160.20.128');
  assert.equal(r.ok, true);
  assert.equal(r.countryCode, 'SE');
});

await check('IPv6 resolves too', async () => {
  const r = await geoip.lookup('2001:218::1');
  assert.equal(r.ok, true);
  assert.equal(r.countryCode, 'JP');
});

await check('the country edition reports that it has no coordinates', async () => {
  // The distinction the whole geo model rests on: a country database resolves
  // a country and carries no position. Claiming otherwise would put a marker
  // on the globe that no data backs.
  const r = await geoip.lookup('89.160.20.128');
  assert.equal(r.hasCoordinates, false);
  assert.equal(r.lat, null);
});

await check('the city edition carries coordinates and says so', async () => {
  const r0 = await downloadEdition('city', {
    fetchImpl: fakeFetch(['2026-08'], cityFixture), now: new Date('2026-08-20T00:00:00Z'),
  });
  assert.equal(r0.ok, true, r0.error);
  const r = await geoip.lookup('81.2.69.160');
  assert.equal(r.countryCode, 'GB');
  assert.equal(r.hasCoordinates, true);
  assert.ok(Math.abs(r.lat - 51.51) < 0.1 && Math.abs(r.lon - -0.09) < 0.1);
});

await check('an unroutable address is a miss, not a crash', async () => {
  const r = await geoip.lookup('127.0.0.1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-found');
});

await check('a malformed address is reported, not thrown', async () => {
  const r = await geoip.lookup('not-an-address');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-address');
});

check('the attribution the licence requires travels with the data', () => {
  // CC BY 4.0 requires a link back to db-ip.com wherever results are shown.
  assert.equal(geoip.ATTRIBUTION.url, 'https://db-ip.com');
  assert.match(geoip.ATTRIBUTION.text, /DB-IP/);
});

check('country is the default edition and is not the weaker one', () => {
  // 15x smaller and rated more accurate by DB-IP's own index, because city
  // granularity adds error it does not remove.
  assert.ok(geoip.EDITIONS.country.approxBytes < geoip.EDITIONS.city.approxBytes / 10);
  assert.ok(geoip.EDITIONS.country.accuracyIndex > geoip.EDITIONS.city.accuracyIndex);
  assert.equal(geoip.EDITIONS.country.hasCoordinates, false);
});

console.log('\nTOPOLOGY IS DIRECTED:');

const S = (n) => ({ _id: `s${n}` });
const servers = [S(1), S(2), S(3), S(4)];
const node = (id, role, server, upstream = []) => ({ _id: id, role, server, upstream });

check('a legal chain has no problems', () => {
  const p = validateNodes([
    node('n1', 'ingest', 's1'),
    node('n2', 'origin', 's2', ['n1']),
    node('n3', 'edge', 's3', ['n2']),
  ], servers);
  assert.deepEqual(p, []);
});

check('an origin cannot pull from an edge', () => {
  const p = validateNodes([
    node('n1', 'edge', 's1'),
    node('n2', 'origin', 's2', ['n1']),
  ], servers);
  assert.ok(p.some(x => x.code === 'illegal-upstream'), JSON.stringify(p));
});

check('a node cannot feed itself', () => {
  const p = validateNodes([node('n1', 'edge', 's1', ['n1'])], servers);
  assert.ok(p.some(x => x.code === 'self-upstream'));
});

check('a cycle through legal edges is still caught', () => {
  // origin <- mid <- origin is legal edge by edge and impossible as a whole.
  const p = validateNodes([
    node('n1', 'origin', 's1', ['n2']),
    node('n2', 'mid', 's2', ['n1']),
  ], servers);
  assert.ok(p.some(x => x.code === 'cycle'), JSON.stringify(p));
});

check('one server cannot hold two roles in one network', () => {
  const p = validateNodes([
    node('n1', 'origin', 's1'),
    node('n2', 'edge', 's1', ['n1']),
  ], servers);
  assert.ok(p.some(x => x.code === 'duplicate-server'));
});

check('a server that is not in the fleet is refused', () => {
  const p = validateNodes([node('n1', 'edge', 's99')], servers);
  assert.ok(p.some(x => x.code === 'unknown-server'));
});

check('an edge with no upstream is a warning, not a refusal', () => {
  // A network is normally incomplete while it is being built. Refusing to save
  // it would mean building it in one sitting or not at all.
  const p = validateNodes([node('n1', 'edge', 's1')], servers);
  const bad = p.filter(x => x.severity !== 'warning');
  assert.deepEqual(bad, []);
  assert.ok(p.some(x => x.code === 'no-upstream' && x.severity === 'warning'));
});

check('an ingest is not expected to have an upstream', () => {
  assert.deepEqual(ALLOWED_UPSTREAM.ingest, []);
  const p = validateNodes([node('n1', 'ingest', 's1')], servers);
  assert.deepEqual(p, []);
});

check('the gateway is a role but carries no media upstream', () => {
  assert.ok(ROLES.includes('gateway'));
  assert.deepEqual(ALLOWED_UPSTREAM.gateway, []);
});


console.log('\nNODE IDS SURVIVE A SAVE:');

// A node the operator has just added has no id, so the page invents one. It
// used to go straight into _id and into the upstream of whatever pointed at
// it — and mongoose refused the cast, so the save died as a bare 500 that took
// the whole topology with it, and the plan then reported "no edges" about a
// network the operator could see on screen.
const mongoose = (await import('mongoose')).default;
const mintIds = (nodes) => {
  const idMap = new Map();
  const minted = nodes.map(x => {
    const raw = String(x.id ?? '');
    const oid = mongoose.isValidObjectId(raw) ? new mongoose.Types.ObjectId(raw) : new mongoose.Types.ObjectId();
    if (raw) idMap.set(raw, oid);
    return { x, oid };
  });
  const up = (u) => idMap.get(String(u))
    || (mongoose.isValidObjectId(String(u)) ? new mongoose.Types.ObjectId(String(u)) : null);
  return minted.map(({ x, oid }) => ({
    _id: oid, server: x.server, role: x.role,
    upstream: (x.upstream || []).map(up).filter(Boolean),
  }));
};

check('a temporary id becomes a real one', () => {
  const out = mintIds([{ id: 'new-1786365344729-abc12', server: 's1', role: 'edge' }]);
  assert.ok(mongoose.isValidObjectId(out[0]._id));
});

check('a brand new edge can point at a brand new origin in one save', () => {
  const out = mintIds([
    { id: 'new-a', server: 's1', role: 'origin', upstream: [] },
    { id: 'new-b', server: 's2', role: 'edge', upstream: ['new-a'] },
  ]);
  assert.equal(String(out[1].upstream[0]), String(out[0]._id));
});

check('an existing id is kept, not replaced', () => {
  const real = new mongoose.Types.ObjectId().toString();
  const out = mintIds([{ id: real, server: 's1', role: 'origin' }]);
  assert.equal(String(out[0]._id), real);
});

check('a reference to a node that is gone is dropped, not carried', () => {
  const out = mintIds([{ id: 'new-b', server: 's2', role: 'edge', upstream: ['new-vanished'] }]);
  assert.deepEqual(out[0].upstream, []);
});

await fs.rm(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} geo/topology check(s) failed` : '\nall geo & topology checks passed');
process.exit(failures ? 1 : 0);
