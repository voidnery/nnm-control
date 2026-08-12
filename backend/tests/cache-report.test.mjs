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
import { findCacheFields, hitRatio, cacheReport, cacheStores, expectedCacheBytes, RESIDENT_CHUNKS }
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

console.log('\nTHE REAL FIELDS, FROM THE REAL FLEET:');

// RU-2 answered: RamCacheSize=2735 FileCacheSize=0 MaxRamCacheSize=5096
// MaxFileCacheSize=5096. That is occupancy and capacity in megabytes — and no
// hit or miss counters anywhere, which settles the question.
const RU2 = { RamCacheSize: 2735, FileCacheSize: 0, MaxRamCacheSize: 5096, MaxFileCacheSize: 5096 };

check('occupancy and capacity are paired per store', () => {
  const s = cacheStores(findCacheFields(RU2));
  const ram = s.find(x => x.store === 'ram');
  assert.equal(ram.used, 2735);
  assert.equal(ram.capacity, 5096);
  assert.equal(ram.fullPct, 53.7);
  assert.equal(ram.unit, 'MB');
});

check('a file cache holding nothing is 0%, not missing', () => {
  // Zero used against a real capacity is a fact worth showing: this edge keeps
  // everything in RAM.
  const file = cacheStores(findCacheFields(RU2)).find(x => x.store === 'file');
  assert.equal(file.used, 0);
  assert.equal(file.fullPct, 0);
});

check('occupancy without a capacity yields no percentage', () => {
  // A server reporting only what it holds, with no maximum, cannot say how
  // full it is — and a percentage invented from one number would be the same
  // fault as the "0.0 MB" line, one step further along.
  const only = cacheStores(findCacheFields({ RamCacheSize: 2735 }));
  assert.equal(only[0].used, 2735);
  assert.equal(only[0].capacity, undefined);
  assert.equal(only[0].fullPct, null);
});

check('this Nimble reports no hit or miss counters, and the panel says so', () => {
  // The answer to a question open since the CDN discussion: hit ratio is not
  // measurable from server_status, by any amount of further looking. Better
  // said once than left as a percentage field that never fills in.
  const r = cacheReport({ status: RU2, streams: [] });
  assert.equal(r.ratioAvailable, false);
  assert.equal(r.hitRatio, null);
  assert.equal(r.hasAnyCacheData, true, 'there is cache data, just not that kind');
});

console.log('\nAN IDLE EDGE HAS NO BITRATE TO COMPUTE FROM:');

check('zero-bitrate streams yield no expected size, not a size of zero', () => {
  // A re-streaming route pulls nothing until a viewer asks, so an idle edge
  // reports its streams at zero — and the page said "the cache should hold
  // about 0.0 MB", which is the absence of an input dressed as an answer.
  const e = expectedCacheBytes([{ bandwidth: 0 }, { bandwidth: 0 }]);
  assert.equal(e.bytes, null);
  assert.equal(e.knownBitrates, 0);
  assert.equal(e.streams, 2, 'the streams are still counted');
});

check('one live stream among idle ones is not extrapolated to all', () => {
  // Averaging the unknown ones would turn one measured stream into a confident
  // total for seven.
  const e = expectedCacheBytes([{ bandwidth: 5_000_000 }, { bandwidth: 0 }, { bandwidth: 0 }]);
  assert.equal(e.knownBitrates, 1);
  assert.equal(e.streams, 3);
  assert.ok(e.bytes > 40e6 && e.bytes < 50e6, `${e.bytes}`);
});

console.log(failures ? `\n${failures} cache check(s) failed` : '\nall cache checks passed');
process.exit(failures ? 1 : 0);
