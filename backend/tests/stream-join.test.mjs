// iter16 m1 — pairing Nimble's live stats with WMSPanel's objects.
//
// The field names are not documented and differ between builds, and guessing
// them has cost this project twice. So the join discovers its own key, and
// what is tested is that behaviour: that it finds a key when one exists,
// prefers the stronger of two, and says so plainly when none does.
import assert from 'node:assert/strict';
import { joinLive, liveSummary } from '../src/services/streamJoin.js';

let pass = 0, fail = 0;
const check = (n, f) => {
  try { f(); console.log(`  ✓ ${n}`); pass++; }
  catch (e) { console.log(`  ✗ ${n}: ${e.message}`); fail++; }
};

const wms = [
  { id: 'w1', name: 'CCT_FEED1_EU_BACKUP', ip: '78.17.115.133', port: 18001 },
  { id: 'w2', name: 'BLAST SLAM VII - KK Feed - Stream A', ip: '0.0.0.0', port: 21041 },
];

console.log('FINDING THE KEY:');

check('matches on name when Nimble reports one', () => {
  const r = joinLive([{ name: 'CCT_FEED1_EU_BACKUP', bandwidth: 6.2 }], wms);
  assert.equal(r.strategy, 'name');
  assert.equal(r.matched, 1);
  assert.ok(r.byObjectId.w1);
});

check('falls back to the socket address when it does not', () => {
  const r = joinLive([{ id: '7712', ip: '78.17.115.133', port: 18001, bitrate: 6.2e6 }], wms);
  assert.equal(r.strategy, 'address');
  assert.ok(r.byObjectId.w1);
});

check('a listener is identified by its port alone', () => {
  // 0.0.0.0:21041 and :21041 are the same socket; requiring the host to match
  // would leave every listen-mode stream unmatched.
  const r = joinLive([{ ip: '0.0.0.0', port: 21041, bandwidth: 4 }], wms);
  assert.equal(r.matched, 1);
  assert.ok(r.byObjectId.w2);
});

check('a stronger key wins over a weaker one', () => {
  // Both would match here. Name identifies a stream; a port can be reused.
  const r = joinLive([{ name: 'CCT_FEED1_EU_BACKUP', ip: '78.17.115.133', port: 18001 }], wms);
  assert.equal(r.strategy, 'name');
});

check('an empty field never matches', () => {
  // An empty key matches everything, which is worse than matching nothing.
  const r = joinLive([{ name: '', stream: '', id: '' }], [{ id: 'w9', name: '' }]);
  assert.equal(r.matched, 0);
});

console.log('\nWHEN NOTHING FITS:');

check('it says so, and keeps the evidence', () => {
  // This is the case the whole design exists for: unmatched objects and an
  // offline stream look identical in a table, and only one is a panel problem.
  const entries = [{ socket_id: 5, mbpsRate: 6.1, peer: 'x' }];
  const r = joinLive(entries, wms);
  assert.equal(r.strategy, '');
  assert.equal(r.matched, 0);
  assert.deepEqual(r.unmatchedObjects, ['w1', 'w2']);
  assert.deepEqual(r.unmatchedEntries, entries, 'the only evidence of what the fields are called');
  assert.ok(r.candidates.every(c => c.matched === 0));
});

check('the evidence is bounded', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ socket_id: i }));
  assert.equal(joinLive(many, wms).unmatchedEntries.length, 10);
});

check('empty input is not an error', () => {
  assert.equal(joinLive([], []).matched, 0);
  assert.equal(joinLive().matched, 0);
});

console.log('\nREADING A VALUE OUT OF WHATEVER SHAPE IT HAS:');

check('a rate under a thousand is Mbps, above it is bps', () => {
  // Nimble reports one or the other depending on the build, and 6.2 bits per
  // second is not a video stream.
  assert.equal(liveSummary({ bandwidth: 6.2 }).bps, 6_200_000);
  assert.equal(liveSummary({ bitrate: 6_200_000 }).bps, 6_200_000);
});

check('a stream moving data is online whatever it calls itself', () => {
  assert.equal(liveSummary({ bandwidth: 6 }).online, true);
  assert.equal(liveSummary({ state: 'connected', bandwidth: 0 }).online, true);
  assert.equal(liveSummary({ bandwidth: 0 }).online, false);
});

check('a missing rate is null, not zero', () => {
  // Zero reads as "carrying nothing", which is a different fact from "did not
  // report".
  assert.equal(liveSummary({ rtt: 12 }).bps, null);
  assert.equal(liveSummary(null), null);
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall stream-join checks passed');
process.exit(fail ? 1 : 0);
