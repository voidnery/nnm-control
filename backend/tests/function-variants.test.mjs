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

// The kind list existed in three copies — the runner's KIND_OPS, the object
// browser's if-chain, and the model's enum — and they drifted. `incoming` was
// in the first and in the UI's presets but in neither of the others, so the
// SRT In steps could be built, could not be browsed, and failed to save with a
// mongoose enum violation surfacing as HTTP 500.
console.log('\nOBJECT KINDS (one list, three consumers):');

const { OBJECT_KINDS } = await import('../src/objectKinds.js');
const { KIND_OPS } = await import('../src/services/functionRunner.js');
const { readFileSync } = await import('node:fs');
const routeSrc = readFileSync(new URL('../src/routes/functions.js', import.meta.url), 'utf8');
const modelSrc = readFileSync(new URL('../src/models/FunctionDef.js', import.meta.url), 'utf8');
const uiSrc = readFileSync(new URL('../../frontend/src/pages/FunctionsPage.jsx', import.meta.url), 'utf8');

check('the runner implements exactly the canonical list', () => {
  assert.deepEqual([...OBJECT_KINDS].sort(), Object.keys(KIND_OPS).sort());
});

check('the model enum is derived, not retyped', () => {
  assert.ok(modelSrc.includes('OBJECT_KINDS'), 'a second hand-written list is how this drifted');
  assert.ok(!/enum: \['republish'/.test(modelSrc));
});

check('every kind a preset can produce is one the model accepts', () => {
  const used = new Set([...uiSrc.matchAll(/objectKind: '([a-z_]+)'/g)].map(m => m[1]));
  for (const k of used) {
    assert.ok(OBJECT_KINDS.includes(k), `the UI can build a step of kind "${k}" that cannot be saved`);
  }
  assert.ok(used.has('incoming'), 'the SRT In steps are the ones this broke');
});

check('every per-server kind can be browsed', () => {
  const browsable = new Set([...routeSrc.matchAll(/kind === '([a-z_]+)'/g)].map(m => m[1]));
  const accountLevel = new Set(['transcoder', 'abr', 'alias']);
  for (const k of OBJECT_KINDS) {
    if (accountLevel.has(k)) continue;
    assert.ok(browsable.has(k), `"${k}" cannot be browsed, so its picker is empty`);
  }
});

check('a rejected shape is a 400 with a reason, not a 500', () => {
  // "Internal server error" for a missing field tells the operator nothing and
  // looks like the panel is broken rather than the input.
  assert.ok(routeSrc.includes('function asBadRequest'));
  assert.ok(routeSrc.includes("e?.name === 'ValidationError'"));
});

check('purging run history has a floor the request cannot lower', () => {
  assert.ok(routeSrc.includes('Math.max(1, Math.min(365, Number(req.query.olderThanDays) || 3))'),
    'a mistyped zero must not wipe this morning');
  assert.ok(routeSrc.includes("status: { $ne: 'running' }"), 'a run in flight is not history yet');
});

check('the runs routes are declared before the id routes', () => {
  // Express matches in declaration order. With '/:id' first, DELETE /runs was
  // handled as "delete the function whose id is 'runs'" and came back 500.
  const del = routeSrc.indexOf("functionsRouter.delete('/runs'");
  const byId = routeSrc.indexOf("functionsRouter.delete('/:id'");
  assert.ok(del > 0 && byId > 0 && del < byId, 'the literal path must come first');
});

check('an incoming source is labelled by its name, as the rest of the panel does', () => {
  // Guessing application/stream produced a dropdown of "?/?" — the object
  // carries `name`, and the outgoing tab already resolved it that way.
  assert.ok(uiSrc.includes('const srcLabel'));
  assert.ok(/srcLabel = \(o\) => \{[\s\S]{0,200}o\.name/.test(uiSrc), 'name first');
  assert.ok(!/o\.application \|\| o\.app/.test(uiSrc), 'the guessed fields must be gone');
});

// A "switch the source" step came back with
// `"application":"Sport_tv_obs","stream":"feed1"` in its patch, because the
// generic app/stream inserter was offered for every kind. On an outgoing
// stream those two fields are its OWN name, so that patch renames the stream
// instead of repointing it.
console.log('\nSTEP EDITOR — WHICH FIELDS BELONG TO WHICH KIND:');

check('each kind only offers pairs the object actually has', () => {
  assert.ok(uiSrc.includes('const PAIRS_FOR'));
  const m = /const PAIRS_FOR = \{([\s\S]*?)\};/.exec(uiSrc);
  assert.ok(m, 'the per-kind map must exist');
  assert.match(m[1], /republish: \['src'\]/);
  assert.match(m[1], /udp: \['udps'\]/);
  assert.match(m[1], /outgoing: \['app'\]/);
  // live_pull really does carry application/stream — checked against the tab
  // that edits them, rather than assumed.
  assert.match(m[1], /live_pull: \['app'\]/);
});

check('a source switch offers no generic inserter at all', () => {
  assert.ok(uiSrc.includes('const availablePairs = wantsSource ? [] : pairsFor(step.objectKind)'),
    'there is nothing it could insert that would not be wrong');
  assert.ok(uiSrc.includes('{availablePairs.length > 0 && (<>'), 'and the block is hidden, not just emptied');
});

check('the inserter dropdown is built from the allowed pairs, not all of them', () => {
  assert.ok(!/options=\{KEY_PAIRS\.map/.test(uiSrc), 'offering every pair everywhere is the defect');
  assert.ok(uiSrc.includes('options={availablePairs.map'));
});

check('object labels lead with the name, as every tab does', () => {
  // The picker used to lead with routing detail and drop the name entirely for
  // republish rules and hot swaps, so a named rule could not be found by name.
  assert.ok(uiSrc.includes('const shapeOf'), 'name and shape are separate now');
  assert.ok(/const labelOf = \(o\) => \{[\s\S]{0,120}o\.name/.test(uiSrc));
});

check('the two questions are labelled apart', () => {
  assert.ok(uiSrc.includes("t('fn.whatToChange')"));
  assert.ok(uiSrc.includes("t('fn.changeToWhat')"));
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall function-variant checks passed');
process.exit(fail ? 1 : 0);
