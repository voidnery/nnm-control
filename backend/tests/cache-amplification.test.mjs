// Cache effectiveness without hit counters, iter21 m6.
//
// Nimble reports none — confirmed from three live edges and from Softvelum's
// own documentation. The question behind hit ratio survives anyway: is the
// cache absorbing load, or is every viewer's request going upstream? That is a
// comparison of two traffic figures the server does report.
//
// These checks are almost entirely about the preconditions. The division is
// trivial; a division performed when it should not have been is a confident
// wrong answer, which is worse than the missing metric it replaced.
import assert from 'node:assert/strict';
import { findTrafficFields, amplificationPreconditions, amplification }
  from '../src/services/cacheAmplification.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const EDGE = { role: 'edge' };
const st = (over) => ({ RamCacheSize: 2735, ...over });

console.log('\nTRAFFIC FIELDS, FOUND BY MEANING:');

check('outgoing and incoming are told apart whatever they are called', () => {
  // The names are in no document we have, and every name taken from a document
  // in this project has been wrong.
  const f = findTrafficFields({ OutRate: 5_000_000, InRate: 500_000 });
  assert.equal(f.find(x => x.key === 'OutRate').direction, 'out');
  assert.equal(f.find(x => x.key === 'InRate').direction, 'in');
});

check('a rate is distinguished from a counter', () => {
  // Comparing an instantaneous rate against a lifetime total is not a ratio of
  // anything.
  const f = findTrafficFields({ OutRate: 10, TotalBytesIn: 999 });
  assert.equal(f.find(x => x.key === 'OutRate').rate, true);
  assert.equal(f.find(x => x.key === 'TotalBytesIn').rate, false);
});

check('unrelated numbers are not traffic', () => {
  assert.deepEqual(findTrafficFields({ RamCacheSize: 2735, Uptime: 900 }), []);
});

check('a word that merely contains "in" is not incoming traffic', () => {
  // `in` is a substring of half the language, and `Interfaces` is a field on
  // this very endpoint. A substring match would classify the interface count
  // as origin traffic and divide by it — a confidently wrong ratio, which is
  // worse than the missing metric it replaces.
  for (const key of ['Interfaces', 'Instances', 'Uptime', 'MaxIndex', 'Bins']) {
    assert.deepEqual(findTrafficFields({ [key]: 5 }), [], key);
  }
  // And the genuine ones still match, at either end of the name.
  assert.equal(findTrafficFields({ InRate: 1 })[0].direction, 'in');
  assert.equal(findTrafficFields({ TotalBytesIn: 1 })[0].direction, 'in');
});

console.log('\nTHE PRECONDITIONS ARE THE POINT:');

check('an origin cannot be measured this way, and is refused', () => {
  // An origin also ingests SRT, and that lands in the same "in" figure — a
  // working cache would look broken. This is the check that keeps the number
  // from being confidently wrong on the fleet's own selectel box.
  const b = amplificationPreconditions({
    node: { role: 'origin' }, viewers: 10,
    fields: findTrafficFields({ OutRate: 10, InRate: 1 }),
  });
  assert.ok(b.includes('not-an-edge'));
});

check('with nobody watching there is nothing to compare', () => {
  // Both figures approach zero and their ratio is noise. An idle edge is the
  // normal state of a pull-based network, so this is the common case.
  const b = amplificationPreconditions({
    node: EDGE, viewers: 0, fields: findTrafficFields({ OutRate: 0, InRate: 0 }),
  });
  assert.ok(b.includes('no-viewers'));
});

check('a rate against a counter is refused rather than divided', () => {
  const b = amplificationPreconditions({
    node: EDGE, viewers: 5, fields: findTrafficFields({ OutRate: 100, TotalBytesIn: 90 }),
  });
  assert.ok(b.includes('mismatched-units'));
});

check('a response with no traffic figures says so', () => {
  const b = amplificationPreconditions({ node: EDGE, viewers: 5, fields: findTrafficFields(st({})) });
  assert.ok(b.includes('no-traffic-fields'));
});

console.log('\nWHAT THE NUMBER MEANS:');

check('a cache absorbing load shows amplification near the audience', () => {
  // Ten viewers of a 5 Mbps stream: 50 Mbps out, 5 Mbps in from the origin.
  const r = amplification({ status: st({ OutRate: 50e6, InRate: 5e6 }), node: EDGE, viewers: 10 });
  assert.equal(r.ratio, 10);
  assert.equal(r.code, 'cache-absorbing');
  assert.equal(r.efficiency, 100);
});

check('a cache doing nothing shows amplification near one', () => {
  // Every viewer's request went upstream. This is what HTTP Origin mode looks
  // like from the outside, and the fault the whole panel warns about.
  const r = amplification({ status: st({ OutRate: 50e6, InRate: 48e6 }), node: EDGE, viewers: 10 });
  assert.ok(r.ratio < 1.5);
  assert.equal(r.code, 'cache-not-absorbing');
});

check('partial absorption is its own answer', () => {
  const r = amplification({ status: st({ OutRate: 50e6, InRate: 15e6 }), node: EDGE, viewers: 10 });
  assert.equal(r.code, 'cache-partial');
});

check('serving with nothing incoming is said in words, not divided by zero', () => {
  // A window served entirely from cache. Infinity is not an answer a person
  // can read.
  const r = amplification({ status: st({ OutRate: 50e6, InRate: 0 }), node: EDGE, viewers: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.ratio, null);
  assert.equal(r.code, 'served-entirely-from-cache');
});

check('a refused measurement carries its reasons and the fields it saw', () => {
  const r = amplification({ status: st({ OutRate: 1, InRate: 1 }), node: EDGE, viewers: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.blocking.includes('no-viewers'));
  assert.ok(r.out, 'the fields it found are still shown');
});

check('the fields a number came from are named', () => {
  const r = amplification({ status: st({ OutRate: 50e6, InRate: 5e6 }), node: EDGE, viewers: 10 });
  assert.deepEqual(r.from, ['OutRate', 'InRate']);
});

console.log(failures ? `\n${failures} amplification check(s) failed` : '\nall amplification checks passed');
process.exit(failures ? 1 : 0);
