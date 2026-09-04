// What a delivery network carries.
//
// A network is a set of machines *and* a set of applications delivered across
// them, and the second half was missing: "delivered by this network" existed
// only as a side effect of somebody having created a channel record. Two
// places computed the set from that side effect in two different ways — the
// browser posted it in a request body, and `/channels/networks/:id/derived`
// read the database — which is the same shape that cost 23.8 GB of a disk in
// the audit log.
//
// A re-streaming route is per application: `/app/` → `origin:port/app/`. So a
// stream appearing in a carried application is delivered with no further
// action, which is the behaviour the operator expects — and it needs the
// membership to be a recorded fact rather than an inference.
//
// Everything here is about the rules of that set. Nothing reads source text.

import assert from 'node:assert/strict';
import { carriedApplications, appName, isName } from '../src/services/carriedApplications.js';
import { derivePlan } from '../src/services/derivePlan.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

const net = (applications = []) => ({ name: 'prod', applications });
const ch = (application, stream) => ({ application, stream });

console.log('\nTHE SET IS A UNION, AND EVERY MEMBER SAYS WHERE IT CAME FROM:');

check('an application a channel points at is carried, declared or not', () => {
  // The migration case, and the one that must not regress: two channels on
  // `test2` are being delivered today. A declaration mechanism that only
  // counted declarations would stop planning their routes the moment it
  // shipped.
  const r = carriedApplications({ network: net(), channels: [ch('test2', 'a'), ch('test2', 'b')] });
  assert.deepEqual(r.names, ['test2']);
  assert.deepEqual(r.undeclared, ['test2']);
  assert.equal(r.list[0].state, 'undeclared');
  assert.equal(r.list[0].channels, 2);
  assert.deepEqual(r.list[0].streams, ['a', 'b']);
});

check('an application the network declares is carried with no channel at all', () => {
  // The whole point: declare it, and every stream that later appears inside it
  // is delivered without anybody typing a channel record.
  const r = carriedApplications({ network: net([{ name: 'feed1' }]), channels: [] });
  assert.deepEqual(r.names, ['feed1']);
  assert.equal(r.list[0].state, 'declared-only');
  assert.deepEqual(r.undeclared, []);
});

check('declared and pointed-at is one entry, not two', () => {
  const r = carriedApplications({ network: net([{ name: 'test2' }]), channels: [ch('test2', 'a')] });
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].state, 'declared');
  assert.deepEqual(r.names, ['test2']);
});

check('switching one off drops it from the plan and says so', () => {
  // Not resolved quietly in either direction. An apply never deletes a route,
  // so the consequence of switching off is that the plan stops covering an
  // application that is still being delivered — a thing to report, not to
  // decide behind somebody's back.
  const r = carriedApplications({ network: net([{ name: 'test2', enabled: false }]),
                                  channels: [ch('test2', 'a')] });
  assert.deepEqual(r.names, []);
  assert.deepEqual(r.conflicts, ['test2']);
  assert.equal(r.list[0].state, 'disabled-with-channels');
});

check('switching off something no channel points at is not a conflict', () => {
  const r = carriedApplications({ network: net([{ name: 'old', enabled: false }]), channels: [] });
  assert.deepEqual(r.names, []);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.list[0].state, 'disabled');
});

check('the set is sorted and free of duplicates', () => {
  const r = carriedApplications({
    network: net([{ name: 'zeta' }, { name: 'alpha' }, { name: 'alpha' }]),
    channels: [ch('zeta', 'x'), ch('mid', 'y')],
  });
  assert.deepEqual(r.list.map(e => e.name), ['alpha', 'mid', 'zeta']);
});

console.log('\nAN APPLICATION NAME IS NOT TIDIED UP:');

check('a leading tab survives, because a real application has one', () => {
  // `NimbleGER-1` carries `\tblast_feed_cs` — docs/STATE.md. The name goes
  // into a playback path, so stripping the whitespace declares an application
  // that does not exist while the origin publishes another. The two
  // normalisers that were already in the codebase strip slashes and nothing
  // else; the first version of this one added `.trim()`.
  assert.equal(appName('\tblast_feed_cs'), '\tblast_feed_cs');
  const r = carriedApplications({ network: net([{ name: '\tblast_feed_cs' }]), channels: [] });
  assert.deepEqual(r.names, ['\tblast_feed_cs']);
});

check('a tab-prefixed application and its trimmed twin are two different things', () => {
  // Because they are: one exists on the origin and one does not. Folding them
  // together would silently deliver the wrong one.
  const r = carriedApplications({
    network: net([{ name: '\tblast_feed_cs' }, { name: 'blast_feed_cs' }]), channels: [],
  });
  assert.equal(r.list.length, 2);
});

check('surrounding slashes are stripped, as everywhere else in the planner', () => {
  // `/test2/` and `test2` are the same application: the slashes come from
  // somebody pasting a path. This half of the normalisation matches
  // `deliveryPlan.js` and `derivePlan.js`, which is the point.
  assert.equal(appName('/test2/'), 'test2');
  const r = carriedApplications({ network: net([{ name: '/test2/' }]), channels: [ch('test2', 'a')] });
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].state, 'declared');
});

check('whitespace alone is not a name, whitespace in front of one is', () => {
  assert.equal(isName('   '), false);
  assert.equal(isName('\t'), false);
  assert.equal(isName('\tfeed'), true);
  const r = carriedApplications({ network: net([{ name: '  ' }, { name: '' }, { name: '\tfeed' }]),
                                  channels: [] });
  assert.deepEqual(r.names, ['\tfeed']);
});

console.log('\nNOTHING ELSE MAY COMPUTE THIS SET:');

check('derivePlan refuses to guess it', () => {
  // It used to reduce channel records to applications itself, which was the
  // second copy of the rule. A default would let a caller forget and still get
  // a plausible answer from the wrong set.
  assert.throws(() => derivePlan({ network: net(), servers: [], channels: [ch('test2', 'a')] }),
                /carried applications/);
});

if (failures) { console.log(`\n${failures} carried check(s) failed`); process.exit(1); }
console.log('\nall carried checks passed');
