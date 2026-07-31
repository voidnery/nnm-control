import assert from 'node:assert/strict';
import { cacheGet, cacheSet, cacheClear, rememberFilters, recallFilters } from '../src/lib/logCache.js';

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}: ${e.message}`); fail++; } };

console.log('VIEW CACHE:');
cacheClear();

check('a stored result comes back with its age', () => {
  cacheSet('k1', { rows: [1, 2] });
  const hit = cacheGet('k1');
  assert.deepEqual(hit.data, { rows: [1, 2] });
  assert.ok(hit.ageMs >= 0 && hit.ageMs < 1000);
});

check('a different query is a different key', () => {
  assert.equal(cacheGet('k-other'), null);
});

check('an entry past its age is dropped, not served', () => {
  cacheSet('k2', 'old');
  assert.equal(cacheGet('k2', { maxAgeMs: 0 }), null);
  assert.equal(cacheGet('k2'), null, 'and it is evicted, not left to be served later');
});

check('the cache is bounded — tuning filters must not grow it without limit', () => {
  cacheClear();
  for (let i = 0; i < 200; i++) cacheSet(`k${i}`, i);
  // 40 is the ceiling; the oldest go first.
  assert.equal(cacheGet('k0'), null, 'the earliest key must have been evicted');
  assert.ok(cacheGet('k199'), 'the most recent must survive');
});

check('reading an entry keeps it, so the active query is not evicted', () => {
  cacheClear();
  cacheSet('hot', 'x');
  for (let i = 0; i < 39; i++) { cacheGet('hot'); cacheSet(`f${i}`, i); }
  assert.ok(cacheGet('hot'), 'the query being looked at must not be pushed out by its own refinements');
});

console.log('\nFILTERS:');

check('filters survive leaving the page', () => {
  rememberFilters('logs', { serverId: 'S1', range: '6h' });
  assert.deepEqual(recallFilters('logs', {}), { serverId: 'S1', range: '6h' });
});

check('a page never seen falls back', () => {
  assert.deepEqual(recallFilters('nope', { range: '1h' }), { range: '1h' });
});

check('pages do not share filters', () => {
  rememberFilters('logCategories', { range: '15m' });
  assert.equal(recallFilters('logs', {}).range, '6h');
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall view-cache checks passed');
process.exit(fail ? 1 : 0);
