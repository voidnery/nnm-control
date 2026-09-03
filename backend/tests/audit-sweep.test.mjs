// The sweep loop, run.
//
// The thing this is about is not how fast rows are deleted. It is that a
// running sweep and a stalled one stopped looking the same. On 2026-09-03 a
// single `deleteMany` over 29.4 million rows printed one line and went quiet
// for as long as it took; the operator read the silence as a hung job, went to
// the database by hand on a machine with 1.3 GB free, and found the work had
// already finished. Every assertion here is about what the caller is told.

import assert from 'node:assert/strict';
import { deleteInBatches } from '../src/services/audit.js';

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

// A pretend collection of `n` matching rows that deletes what it is given.
function collection(n) {
  let left = n;
  return {
    find: async (batch) => Array.from({ length: Math.min(batch, left) }, (_, i) => `id${i}`),
    remove: async (ids) => { left -= ids.length; return ids.length; },
    get remaining() { return left; },
  };
}

console.log('\nTHE SWEEP SAYS WHERE IT HAS GOT TO:');

await check('every batch reports, so silence means stopped and not working', async () => {
  const c = collection(250);
  const seen = [];
  const out = await deleteInBatches({ find: c.find, remove: c.remove, batch: 100,
                                      onProgress: (p) => seen.push(p.removed) });
  assert.equal(out.removed, 250);
  assert.deepEqual(seen, [100, 200, 250], 'the caller was not told about every batch');
});

await check('progress is cumulative and carries elapsed seconds', async () => {
  const c = collection(30);
  let clock = 1000;
  const seen = [];
  await deleteInBatches({ find: c.find, remove: c.remove, batch: 10,
                          now: () => (clock += 5000),
                          onProgress: (p) => seen.push(p) });
  assert.deepEqual(seen.map(p => p.removed), [10, 20, 30]);
  assert.ok(seen.every(p => Number.isFinite(p.seconds)), 'no elapsed time is reported');
  assert.ok(seen[2].seconds > seen[0].seconds, 'the clock does not advance in the report');
});

await check('nothing to remove finishes at once and reports nothing', async () => {
  const seen = [];
  const out = await deleteInBatches({ find: async () => [], remove: async () => 0,
                                      onProgress: (p) => seen.push(p) });
  assert.deepEqual(out, { removed: 0, stalled: false });
  assert.equal(seen.length, 0);
});

await check('a batch that matches rows and removes none stops instead of spinning', async () => {
  // The same fault in a new place: a loop that makes no progress and says the
  // same thing forever. It must end, and it must say that it ended this way.
  //
  // Bounded on purpose, and bounded by counting rather than by a timer.
  //
  // Removing the guard makes this loop run forever, and a check that hangs
  // takes the whole suite with it — which is its own kind of check that cannot
  // fail. The first attempt at bounding it used `Promise.race` with a
  // `setTimeout`, and that never fired: the loop awaits promises that are
  // already resolved, so it never yields to the timer queue at all. The stub
  // itself is the only thing that can stop it.
  let calls = 0;
  const out = await deleteInBatches({
    find: async () => {
      if (++calls > 5) throw new Error(`never terminated — ${calls} passes without progress`);
      return ['id0'];
    },
    remove: async () => 0,
    batch: 1,
  });
  assert.equal(out.stalled, true);
  assert.equal(out.removed, 0);
  assert.ok(calls <= 2, `the loop ran ${calls} times without making progress`);
});

await check('the work is done in more than one commit', async () => {
  // The reason batching exists at all: one commit over 29 million rows is
  // unbounded journal on a disk that is nearly full, which is exactly the
  // situation this feature is reached for.
  const c = collection(1000);
  let removes = 0;
  await deleteInBatches({ find: c.find, remove: async (ids) => { removes++; return c.remove(ids); },
                          batch: 250 });
  assert.ok(removes >= 4, `${removes} delete call(s) — the batch size is not being honoured`);
  assert.equal(c.remaining, 0);
});

if (failures) { console.log(`\n${failures} sweep check(s) failed`); process.exit(1); }
console.log('\nall sweep checks passed');
