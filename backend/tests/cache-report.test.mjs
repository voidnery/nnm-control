// The cache, iter21 m6.
//
// It is the heart of a delivery network — request coalescing is what turns a
// thousand viewers into one fetch upstream — and WMSPanel does not report it.
// Softvelum's own Zabbix templates read it from `/manage/server_status`, the
// endpoint this panel already calls.
//
// The rule these checks exist for: report what was found, never what was
// expected. Field names taken from documentation have been wrong every single
// time in this project — the `to` of a route, the DASH manifest path, two TLS
// fields that existed nowhere — so this reads whatever cache-shaped keys are
// present and names them, rather than reaching for names it does not have.
import assert from 'node:assert/strict';
import { findCacheFields, hitRatio, cacheReport, expectedCacheBytes, RESIDENT_CHUNKS }
  from '../src/services/cacheReport.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

console.log('\nWHATEVER NIMBLE CALLS IT, THE PANEL FINDS IT:');

check('cache fields are found by meaning, not by an exact name', () => {
  // Because the exact names are unknown. Three plausible shapes, none of them
  // assumed to be the real one.
  const a = findCacheFields({ RamCacheSize: 4096, Uptime: 900 });
  assert.deepEqual(a.map(f => f.path), ['RamCacheSize']);

  const b = findCacheFields({ cache: { used_bytes: 12, capacity_bytes: 99 } });
  assert.deepEqual(b.map(f => f.path).sort(), ['cache.capacity_bytes', 'cache.used_bytes']);

  const c = findCacheFields({ server: { chunk_cache: { hits: 900, misses: 4 } } });
  assert.equal(c.length, 2);
});

check('unrelated numbers are left alone', () => {
  // A report full of everything is a report nobody reads.
  const f = findCacheFields({ cpu: 42, connections: 7, uptime_sec: 900 });
  assert.deepEqual(f, []);
});

check('the path is kept, so a number can be traced to its field', () => {
  const f = findCacheFields({ stats: { ram_cache: { size: 8 } } });
  assert.equal(f[0].path, 'stats.ram_cache.size');
});

console.log('\nA RATIO ONLY WHEN THE NUMBERS FOR ONE EXIST:');

check('hits and misses give a ratio, and say where they came from', () => {
  const r = hitRatio(findCacheFields({ cache: { hits: 950, misses: 50 } }));
  assert.equal(r.ratio, 95);
  assert.deepEqual(r.from, ['cache.hits', 'cache.misses']);
});

check('no counters means no ratio, not zero', () => {
  // A confident 0% about a cache that may be working perfectly is worse than
  // admitting the server did not say.
  assert.equal(hitRatio(findCacheFields({ RamCacheSize: 4096 })), null);
});

check('a cache nothing has touched yet reports its counters and no ratio', () => {
  // 0 hits and 0 misses is a fresh server, not a broken one.
  const r = hitRatio(findCacheFields({ cache: { hits: 0, misses: 0 } }));
  assert.equal(r.ratio, null);
  assert.equal(r.hits, 0);
});

console.log('\nWHAT THE CACHE SHOULD NEED, BEFORE ANYTHING IS MEASURED:');

check('resident chunks follow the documented behaviour', () => {
  // Softvelum: four chunks stay in the playlist, and one leaving it gets a
  // 45-second timeout. Six-second chunks therefore hold 4 + 8.
  assert.equal(RESIDENT_CHUNKS(6), 4 + Math.ceil(45 / 6));
  assert.equal(RESIDENT_CHUNKS(10), 4 + Math.ceil(45 / 10));
});

check('the RAM a stream needs is computed from its own bitrate', () => {
  const e = expectedCacheBytes([{ bandwidth: 1_000_000 }], { chunkSeconds: 6 });
  // 12 chunks × 6s × 1 Mbit/s ÷ 8 ≈ 9 MB.
  assert.ok(e.bytes > 8_000_000 && e.bytes < 10_000_000, `${e.bytes}`);
  assert.equal(e.chunksPerStream, 12);
});

check('it does not grow with the audience, and says so', () => {
  // The counter-intuitive part, and the reason this is worth showing at all:
  // a thousand viewers of one stream need the same chunks as one viewer.
  const e = expectedCacheBytes([{ bandwidth: 5_000_000 }]);
  assert.equal(e.independentOfViewers, true);
});

console.log('\nMEASURED AND COMPUTED ARE NOT MIXED:');

check('a report says whether anything was actually reported', () => {
  const empty = cacheReport({ status: { cpu: 10 }, streams: [{ bandwidth: 1e6 }] });
  assert.equal(empty.hasAnyCacheData, false);
  assert.equal(empty.hitRatio, null);
  // The computed figure is still there — it does not depend on the server
  // saying anything — but it lives in its own field.
  assert.ok(empty.expected.bytes > 0);
});

check('reported figures keep their own names in their own place', () => {
  const r = cacheReport({ status: { cache: { used: 100, hits: 9, misses: 1 } }, streams: [] });
  assert.equal(r.hasAnyCacheData, true);
  assert.equal(r.hitRatio.ratio, 90);
  assert.ok(r.reported.some(f => f.path === 'cache.used'));
});

console.log(failures ? `\n${failures} cache check(s) failed` : '\nall cache checks passed');
process.exit(failures ? 1 : 0);
