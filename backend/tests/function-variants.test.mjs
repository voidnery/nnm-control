// iter11 2a/2b — switching sources, and running one function with several
// sets of values.
//
// Both halves touch live broadcast servers, and both fail quietly if they are
// wrong: a verification that is too strict rolls back a change that worked, a
// variant that resolves wrongly switches streams to inputs nobody chose. So
// the resolver is a pure function and it is tested exhaustively.
import assert from 'node:assert/strict';
import { valueEq, valuesMatch, resolveVariant } from '../src/services/functionRunner.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

console.log('2a — VERIFYING A NESTED SOURCE REFERENCE:');

// The real shape: the patch names an id, WMSPanel answers with the whole
// object. Byte comparison would never hold.
const SERVED = {
  video_source: { id: 'inc-77', application: 'live', stream: 'cam1' },
  audio_source: { id: 'inc-77', application: 'live', stream: 'cam1' },
  paused: false,
  status: 'synced',
};

check('a patched source verifies against the fuller object the API returns', () => {
  assert.equal(valuesMatch(SERVED, { video_source: { id: 'inc-77' } }), true,
    'stringifying whole objects would fail here and roll back a change that worked');
});

check('the wrong source still fails verification', () => {
  assert.equal(valuesMatch(SERVED, { video_source: { id: 'inc-99' } }), false);
});

check('video and audio are checked independently', () => {
  const mixed = { ...SERVED, audio_source: { id: 'inc-12', application: 'live', stream: 'mic' } };
  assert.equal(valuesMatch(mixed, { video_source: { id: 'inc-77' }, audio_source: { id: 'inc-77' } }), false);
  assert.equal(valuesMatch(mixed, { video_source: { id: 'inc-77' }, audio_source: { id: 'inc-12' } }), true);
});

check('arrays stay exact — an extra element means the patch did not take', () => {
  const got = { source_streams: [{ application: 'a', stream: 'b' }, { application: 'c', stream: 'd' }] };
  assert.equal(valuesMatch(got, { source_streams: [{ application: 'a', stream: 'b' }] }), false);
  assert.equal(valueEq([1, 2], [1, 2]), true);
  assert.equal(valueEq([1, 2], [1]), false);
});

check('flat values still compare as before', () => {
  assert.equal(valueEq('6000', 6000), true, 'the API is loose about string vs number');
  assert.equal(valueEq(true, 'true'), true);
  assert.equal(valueEq(null, 'x'), false);
});

check('a missing field on the object fails rather than passing vacuously', () => {
  assert.equal(valuesMatch({ paused: false }, { video_source: { id: 'x' } }), false);
});

console.log('\n2b — RESOLVING A VARIANT:');

const fn = (overrides = {}, variants = []) => ({
  name: 'Switch feed',
  steps: [
    { type: 'patch', objectKind: 'republish', patch: { src_app: 'live', src_strm: 'cam_a' }, label: 'push' },
    { type: 'delay', waitSec: 5, label: 'settle' },
    { type: 'patch', objectKind: 'outgoing', patch: { video_source: { id: 'inc-a' }, audio_source: { id: 'inc-a' } }, label: 'srt' },
  ],
  variants,
  ...overrides,
});

check('no variants and none asked for: the steps run untouched', () => {
  const r = resolveVariant(fn(), '');
  assert.equal(r.variant, null);
  assert.deepEqual(r.steps[0].patch, { src_app: 'live', src_strm: 'cam_a' });
});

check('a function WITH variants refuses to run without one being chosen', () => {
  // Running the wrong inputs is exactly the failure this feature exists to
  // prevent, so silently falling back to the base steps is not an option.
  assert.throws(() => resolveVariant(fn({}, [{ id: 'a', name: 'A', overrides: {} }]), ''), /pick one/);
});

check('an unknown variant id is an error, not a silent fallback', () => {
  assert.throws(() => resolveVariant(fn({}, [{ id: 'a', name: 'A', overrides: {} }]), 'nope'), /Unknown variant/);
});

check('an override replaces only the fields it names', () => {
  const d = fn({}, [{ id: 'b', name: 'Camera B', overrides: { 0: { src_strm: 'cam_b' } } }]);
  const r = resolveVariant(d, 'b');
  assert.deepEqual(r.steps[0].patch, { src_app: 'live', src_strm: 'cam_b' },
    'src_app must survive — a variant names differences, not whole patches');
  assert.equal(r.variant.name, 'Camera B');
});

check('steps the variant says nothing about are left alone', () => {
  const d = fn({}, [{ id: 'b', name: 'B', overrides: { 0: { src_strm: 'cam_b' } } }]);
  const r = resolveVariant(d, 'b');
  assert.deepEqual(r.steps[2].patch, { video_source: { id: 'inc-a' }, audio_source: { id: 'inc-a' } });
  assert.equal(r.steps[1].waitSec, 5);
});

check('a nested source can be overridden wholesale', () => {
  const d = fn({}, [{ id: 'b', name: 'B', overrides: { 2: { video_source: { id: 'inc-b' } } } }]);
  const r = resolveVariant(d, 'b');
  assert.deepEqual(r.steps[2].patch.video_source, { id: 'inc-b' });
  assert.deepEqual(r.steps[2].patch.audio_source, { id: 'inc-a' }, 'the other source is untouched');
});

check('several steps can be overridden at once', () => {
  const d = fn({}, [{ id: 'b', name: 'B', overrides: { 0: { src_strm: 'cam_b' }, 2: { video_source: { id: 'inc-b' }, audio_source: { id: 'inc-b' } } } }]);
  const r = resolveVariant(d, 'b');
  assert.equal(r.steps[0].patch.src_strm, 'cam_b');
  assert.deepEqual(r.steps[2].patch.audio_source, { id: 'inc-b' });
});

check('resolving does not mutate the stored definition', () => {
  // The same document is resolved once per run. A resolver that wrote through
  // would make the second run inherit the first one's variant.
  const d = fn({}, [{ id: 'b', name: 'B', overrides: { 0: { src_strm: 'cam_b' } } }]);
  resolveVariant(d, 'b');
  assert.equal(d.steps[0].patch.src_strm, 'cam_a', 'the definition must be untouched');
  const again = resolveVariant(d, 'b');
  assert.equal(again.steps[0].patch.src_strm, 'cam_b');
});

check('an override for a step index that does not exist is ignored, not fatal', () => {
  const d = fn({}, [{ id: 'b', name: 'B', overrides: { 9: { src_strm: 'x' } } }]);
  const r = resolveVariant(d, 'b');
  assert.equal(r.steps.length, 3);
  assert.equal(r.steps[0].patch.src_strm, 'cam_a');
});

check('a junk override value is ignored rather than corrupting the patch', () => {
  for (const bad of [null, 'string', 42, []]) {
    const d = fn({}, [{ id: 'b', name: 'B', overrides: { 0: bad } }]);
    const r = resolveVariant(d, 'b');
    assert.deepEqual(r.steps[0].patch, { src_app: 'live', src_strm: 'cam_a' }, `override ${JSON.stringify(bad)}`);
  }
});

check('a step with no patch is unaffected by an override on it', () => {
  const d = fn({}, [{ id: 'b', name: 'B', overrides: { 1: { waitSec: 99 } } }]);
  const r = resolveVariant(d, 'b');
  // The override merges into `patch`, never into the step's own machinery —
  // a variant must not be able to turn a delay into something else.
  assert.equal(r.steps[1].waitSec, 5);
  assert.deepEqual(r.steps[1].patch, { waitSec: 99 });
});

check('a variant with no overrides is the base steps under a name', () => {
  const d = fn({}, [{ id: 'plain', name: 'Plain', overrides: {} }]);
  const r = resolveVariant(d, 'plain');
  assert.deepEqual(r.steps[0].patch, { src_app: 'live', src_strm: 'cam_a' });
  assert.equal(r.variant.id, 'plain');
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall function-variant checks passed');
process.exit(fail ? 1 : 0);
