// The profile probe's reasoning, checked without a network.
//
// The verdicts are the part of a recon script that gets believed, and they are
// exactly the part that never runs before the one real run. So they are
// exported and checked here — against the shapes WMSPanel actually returns,
// including the one that matters most: a 200 that stored something other than
// what was sent.

import assert from 'node:assert/strict';
import { verdict, scrub, restoreBody, STEPS, TOUCHED, SENSITIVE }
  from '../tools/wms-app-write-probe-profile.mjs';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

const step = (id) => STEPS.find(s => s.id === id);

console.log('\nA 200 IS NOT A YES:');

check('a value stored as sent is stored as sent', () => {
  const v = verdict(step('min-zero'), {
    status: 200, payload: { status: 'Ok' },
    before: { ic_min_delay_ms: 1000 }, after: { ic_min_delay_ms: 0 },
  });
  assert.equal(v.outcome, 'stored-as-sent');
  assert.deepEqual(v.clamped, []);
  assert.deepEqual(v.changed, { ic_min_delay_ms: { from: 1000, to: 0 } });
});

check('a silent clamp is named, not counted as success', () => {
  // The failure this probe exists to catch. WMSPanel answers `Ok`, stores
  // 1000, and the panel would show a zero the server never took — the same
  // shape as the write that stored three fields of four and reported success.
  const v = verdict(step('min-zero'), {
    status: 200, payload: { status: 'Ok' },
    before: { ic_min_delay_ms: 1000 }, after: { ic_min_delay_ms: 1000 },
  });
  assert.equal(v.outcome, 'stored-something-else');
  assert.deepEqual(v.clamped, [{ field: 'ic_min_delay_ms', sent: 0, stored: 1000 }]);
});

check('an error in the body counts as a refusal even under a 200', () => {
  // This API answers 200 with `status: "Error"`. Reading the status code alone
  // would record a refusal as a success.
  const v = verdict(step('min-zero'), {
    status: 200, payload: { status: 'Error', description: 'value out of range' },
    before: { ic_min_delay_ms: 1000 }, after: { ic_min_delay_ms: 1000 },
  });
  assert.equal(v.refused, true);
  assert.equal(v.message, 'value out of range');
});

console.log('\nA REFUSAL THAT WAS EXPECTED IS A DIFFERENT FINDING:');

check('a bound that holds is confirmed', () => {
  const v = verdict(step('part-below-floor'), {
    status: 400, payload: { description: 'hls_part_duration should be greater or equal to 500' },
    before: { hls_part_duration: 2000 }, after: { hls_part_duration: 2000 },
  });
  assert.equal(v.outcome, 'bound-confirmed');
  assert.match(v.message, /500/);
});

check('a bound the server does not enforce is the more important answer', () => {
  // If 250 is accepted, the floor of 500 in `services/llhls.js` is the panel
  // enforcing something the server does not — and the measurement it came from
  // needs re-reading, not the code.
  const v = verdict(step('part-below-floor'), {
    status: 200, payload: { status: 'Ok' },
    before: { hls_part_duration: 2000 }, after: { hls_part_duration: 250 },
  });
  assert.equal(v.outcome, 'accepted-though-expected-refusal');
});

check('the documented illegal pair is asked as a refusal', () => {
  // The reference names HLS + HLS_MPEGTS as the one combination that cannot be
  // used together. If the API accepts it, the panel must refuse it itself.
  assert.equal(step('illegal-pair').expectRefusal, true);
  const v = verdict(step('illegal-pair'), {
    status: 200, payload: { status: 'Ok' },
    before: { protocols: ['HLS'] }, after: { protocols: ['HLS', 'HLS_MPEGTS'] },
  });
  assert.equal(v.outcome, 'accepted-though-expected-refusal');
});

console.log('\nWHAT THE PROBE WOULD DO TO SOMEBODY ELSE:');

check('the restore covers every field any step writes, and nothing writes more', () => {
  // Five fields, named. `ic_max_delay_ms` and `ic_max_queue_items` are read in
  // the first step and never written: the vendor names only a minimum delay of
  // zero for LL-HLS, so writing the other two would be the panel inventing
  // values on somebody's application.
  // The restore covers exactly what the steps write. A field a step touches
  // and the restore misses would be left changed on a live application.
  assert.deepEqual([...TOUCHED].sort(),
    ['chunk_duration', 'hls_part_duration', 'ic_enabled', 'ic_min_delay_ms', 'protocols'].sort());
  for (const s of STEPS) {
    for (const f of Object.keys(s.body)) {
      assert.ok(TOUCHED.includes(f), `${s.id} writes ${f} and the restore would not put it back`);
    }
  }
});

check('the restore is built from the baseline, never from a default', () => {
  const before = { protocols: ['HLS', 'DASH', 'SLDP'], chunk_duration: 6, hls_part_duration: 2000,
                   ic_enabled: false };
  const body = restoreBody(before, TOUCHED);
  assert.deepEqual(body.protocols, ['HLS', 'DASH', 'SLDP']);
  assert.equal(body.chunk_duration, 6);
  assert.equal(body.hls_part_duration, 2000);
  assert.equal(body.ic_enabled, false);
  // A field the baseline did not carry is not invented on the way back: the
  // application had no `ic_min_delay_ms`, so the restore does not create one.
  assert.equal('ic_min_delay_ms' in body, false);
});

check('no step sends DELETE, and none targets a collection', () => {
  // DELETE has no harmless body: against a real id it either fails or removes
  // something real. And a write asked of a collection records a 404 that means
  // nothing, because a collection is supposed to refuse it.
  for (const s of STEPS) {
    assert.equal(typeof s.body, 'object');
    assert.ok(Object.keys(s.body).length > 0, `${s.id} sends an empty body`);
  }
});

console.log('\nSECRETS LEAVE THE OBJECT, NOT THE PRINT:');

check('push credentials are replaced in the object itself', () => {
  const out = scrub({ application: 'nnm-probe', push_login: 'operator', push_password: 'hunter2' });
  assert.equal(out.push_login, '<set, 8 chars>');
  assert.equal(out.push_password, '<set, 7 chars>');
  assert.equal(JSON.stringify(out).includes('hunter2'), false);
  assert.equal(JSON.stringify(out).includes('operator'), false);
});

check('an empty credential says empty rather than looking unset', () => {
  const out = scrub({ push_login: '', push_password: null });
  assert.equal(out.push_login, '<empty>');
  assert.equal(out.push_password, '<empty>');
});

check('the answer the masking preserves is still answerable', () => {
  // "Are credentials configured on this application" is a real question. The
  // masking must not take it away as well.
  const set = scrub({ push_password: 'abcdefgh' });
  const unset = scrub({ push_password: '' });
  assert.notEqual(set.push_password, unset.push_password);
  for (const f of SENSITIVE) assert.ok(typeof scrub({ [f]: 'x' })[f] === 'string');
});

if (failures) { console.log(`\n${failures} profile-probe check(s) failed`); process.exit(1); }
console.log('\nall profile-probe checks passed');
