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
const { incompleteSteps } = await import('../src/routes/functions.js');
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
  // Name and description are returned as separate fields now, so the dropdown
  // can dim the second — but the name is still what leads.
  // One builder, used by the step editor and the variant editor alike.
  assert.ok(uiSrc.includes('function srcOptionOf'));
  assert.ok(/function srcOptionOf\(o\) \{[\s\S]{0,300}o\.name/.test(uiSrc), 'name first');
  assert.ok(/label: name \|\|/.test(uiSrc), 'the label is the name, not the description');
  assert.ok(uiSrc.includes('const srcOption = srcOptionOf'), 'the step editor uses the shared one');
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

console.log('\nSTEP EDITOR — SMALLER THINGS THAT COST TIME:');

check('audio follows video, unless it was deliberately set apart', () => {
  // The two come from one source in almost every case; setting it twice is a
  // step nobody wants. But an audio pointed somewhere else on purpose must
  // survive a change of video.
  const setSource = (patch, field, id) => {
    const p = { ...patch };
    const prev = p[field]?.id || '';
    p[field] = { id };
    if (field === 'video_source' && 'audio_source' in p) {
      const a = p.audio_source?.id || '';
      if (!a || a === prev) p.audio_source = { id };
    }
    return p;
  };
  assert.deepEqual(setSource({ video_source: { id: '' }, audio_source: { id: '' } }, 'video_source', 'V1').audio_source, { id: 'V1' });
  assert.deepEqual(setSource({ video_source: { id: 'V1' }, audio_source: { id: 'V1' } }, 'video_source', 'V2').audio_source, { id: 'V2' });
  assert.deepEqual(setSource({ video_source: { id: 'V1' }, audio_source: { id: 'A9' } }, 'video_source', 'V2').audio_source, { id: 'A9' });
  assert.ok(uiSrc.includes("if (!audio || audio === prev)"), 'the rule must be in the page, not only here');
});

check('a duplicated step is a deep copy', () => {
  // A shallow copy shares the patch object, so editing one step would silently
  // edit its twin.
  assert.ok(uiSrc.includes('JSON.parse(JSON.stringify({ ...all[i]'));
  assert.ok(uiSrc.includes("(copy)"), 'and it is marked, so two identical rows are tellable apart');
});

check('running a function still asks first, with or without variants', () => {
  const from = uiSrc.indexOf('const run = async (fn, variantId');
  const body = uiSrc.slice(from, from + 700);
  assert.ok(body.includes("confirm(t('fn.confirmRun'"));
  const guard = body.indexOf('setPickVariant(fn); return;');
  const ask = body.indexOf("confirm(t('fn.confirmRun'");
  assert.ok(guard < ask, 'the variant picker comes first, the confirmation always follows');
});

check('a dropdown separates the name from the description', () => {
  const sel = readFileSync(new URL('../../frontend/src/components/Select.jsx', import.meta.url), 'utf8');
  assert.ok(sel.includes('o.hint'), 'run together in one colour they read as one long name');
  assert.ok(sel.includes("color: 'var(--text-dim)'"));
  assert.ok(sel.includes("`${o.label} ${o.hint || ''}`"), 'and search must still cover both');
});

check('a transport failure names its cause instead of saying "fetch failed"', () => {
  const client = readFileSync(new URL('../src/services/wmspanelClient.js', import.meta.url), 'utf8');
  assert.ok(client.includes('WMSPanel API is unreachable'));
  assert.ok(client.includes('cause?.code'), 'the reason Node hides in `cause` is what an operator needs');
  assert.ok(client.includes("e?.name === 'AbortError'"), 'a timeout is its own message');
});

console.log('\nVARIANT EDITOR — CONTROLS, NOT JSON:');

// The rule the controls implement: a value equal to the step's own is not an
// override, and a variant that overrides nothing carries no entry at all.
function setKey(base, override, key, value) {
  const next = { ...(override || {}) };
  if (JSON.stringify(value) === JSON.stringify(base[key])) delete next[key];
  else next[key] = value;
  return Object.keys(next).length ? next : null;
}

check('changing a value records it as an override', () => {
  const base = { video_source: { id: 'A' }, audio_source: { id: 'A' } };
  const o = setKey(base, null, 'video_source', { id: 'B' });
  assert.deepEqual(o, { video_source: { id: 'B' } });
});

check('setting a value back to the step\'s own drops the override', () => {
  // A variant that claims to change something it does not is a variant that
  // will confuse whoever reads it next.
  const base = { video_source: { id: 'A' } };
  const o = setKey(base, { video_source: { id: 'B' } }, 'video_source', { id: 'A' });
  assert.equal(o, null, 'and with nothing left, the whole entry goes');
});

check('one field can differ while another follows the step', () => {
  const base = { video_source: { id: 'A' }, audio_source: { id: 'A' } };
  const o = setKey(base, null, 'audio_source', { id: 'MIC' });
  assert.deepEqual(o, { audio_source: { id: 'MIC' } });
  assert.ok(!('video_source' in o), 'unchanged fields fall through to the step');
});

check('audio follows video inside a variant too', () => {
  // The rule lived only in the step editor, so picking a video source in a
  // variant left the audio behind. It is one function used by both now.
  const withSourceFollow = (current, field, id) => {
    const next = { ...current };
    const prev = current[field]?.id || '';
    next[field] = { id };
    if (field === 'video_source' && 'audio_source' in current) {
      const audio = current.audio_source?.id || '';
      if (!audio || audio === prev) next.audio_source = { id };
    }
    return next;
  };
  const pick = (base, override, key, id) => {
    const current = {};
    for (const k of Object.keys(base)) current[k] = (k in (override || {}) ? override[k] : base[k]);
    const next = { ...(override || {}) };
    for (const [k, v] of Object.entries(withSourceFollow(current, key, id))) {
      if (JSON.stringify(v) === JSON.stringify(base[k])) delete next[k];
      else next[k] = v;
    }
    return Object.keys(next).length ? next : null;
  };

  const base = { video_source: { id: 'A' }, audio_source: { id: 'A' } };
  const b = pick(base, null, 'video_source', 'B');
  assert.deepEqual(b, { video_source: { id: 'B' }, audio_source: { id: 'B' } });

  // The second change must compare against the variant's own value, not the
  // step's, or audio would stop following after the first pick.
  assert.deepEqual(pick(base, b, 'video_source', 'C'),
    { video_source: { id: 'C' }, audio_source: { id: 'C' } });

  // An audio set apart in the variant survives a change of video.
  assert.deepEqual(pick(base, { audio_source: { id: 'MIC' } }, 'video_source', 'B'),
    { audio_source: { id: 'MIC' }, video_source: { id: 'B' } });

  // Back to the step's own value and the override disappears entirely.
  assert.equal(pick(base, b, 'video_source', 'A'), null);

  assert.ok(uiSrc.includes('export function withSourceFollow'), 'one rule, used twice');
  assert.equal([...uiSrc.matchAll(/if \(!audio \|\| audio === prev\)/g)].length, 1,
    'written once, or the two editors drift again');
});

check('the first variant is seeded from what is already configured', () => {
  // An operator who has configured the function for input A should get A as
  // variant 1, not an empty variant that runs the base steps and looks
  // identical until it is not.
  assert.ok(uiSrc.includes('if (v.length === 0)'));
  assert.ok(uiSrc.includes('seed[String(i)] = JSON.parse(JSON.stringify(st.patch))'),
    'and deep-copied, or editing the variant would edit the step');
});

check('a second variant starts empty, inheriting the steps', () => {
  assert.ok(/const seed = \{\};[\s\S]{0,300}if \(v\.length === 0\)/.test(uiSrc),
    'seeding is for the first one only');
});

check('sources in a variant are picked, not typed', () => {
  assert.ok(uiSrc.includes('function VariantStepFields'));
  assert.ok(uiSrc.includes("key === 'video_source' || key === 'audio_source'"));
  assert.ok(!uiSrc.includes("placeholder={t('fn.variantSame')}"), 'the JSON textarea is gone');
});

check('both editors load sources through one hook', () => {
  // Two loaders would eventually offer different lists for the same server.
  assert.ok(uiSrc.includes('function useIncoming'));
  assert.equal([...uiSrc.matchAll(/objects\/\$\{serverId\}\/incoming/g)].length, 1);
});

console.log('\nRUN PREVIEW — NAMES, NOT IDS:');

check('the preview resolves source ids to names', () => {
  // The preview is the last thing read before a function touches live
  // streams. A wall of 24-character ids is not something anyone can check.
  assert.ok(routeSrc.includes('async function incomingNames'));
  assert.ok(routeSrc.includes("for (const field of ['video_source', 'audio_source'])"));
  assert.ok(routeSrc.includes('resolved'), 'and it is returned alongside the raw patch');
});

check('an unresolvable id degrades to a short id, not a blank', () => {
  assert.ok(routeSrc.includes("`id ${String(id).slice(-8)}`"),
    'an id can still be matched against the incoming list; a blank cannot');
});

check('a failed lookup does not stop the preview', () => {
  // A name is a nicety. Failing to fetch one must not stop an operator seeing
  // what is about to run.
  const from = routeSrc.indexOf('async function incomingNames');
  const body = routeSrc.slice(from, routeSrc.indexOf('functionsRouter.get', from));
  assert.ok(body.includes('} catch {'), 'the lookup is best-effort');
});

check('only servers whose steps reference a source are queried', () => {
  // One upstream call per distinct server, and none at all for a function
  // that switches nothing.
  assert.ok(routeSrc.includes("'video_source' in st.patch || 'audio_source' in st.patch"));
  assert.ok(routeSrc.includes('new Set(steps'));
  assert.ok(routeSrc.includes('NAME_TTL_MS'), 'switching between variants must not re-query each time');
});

check('fields the preview cannot name are still shown as they will be sent', () => {
  // Hiding part of a patch is how one comes to carry something nobody meant.
  assert.ok(uiSrc.includes('const named = new Set(Object.keys(st.resolved || {}))'));
  assert.ok(uiSrc.includes('JSON.stringify(rest)'));
});

console.log('\nVARIANT PICKER — NO FLICKER:');

check('the preview is not cleared before the next one arrives', () => {
  // setPreview(null) emptied the table, which collapsed the dialog and then
  // re-expanded it — read as the whole window blinking.
  const from = uiSrc.indexOf('function VariantPicker');
  const body = uiSrc.slice(from, uiSrc.indexOf('function Builder', from));
  assert.ok(!/setPreview\(null\)/.test(body), 'clearing first is what caused the collapse');
  assert.ok(body.includes('cache.current.set(sel, d)'), 'each answer is kept');
  assert.ok(body.includes('cache.current.get(sel)'), 'and shown at once when it is already known');
});

check('what is on screen is never passed off as the selected variant', () => {
  // Keeping the old table is only honest if it says which variant it belongs
  // to while a different one loads.
  const from = uiSrc.indexOf('function VariantPicker');
  const body = uiSrc.slice(from, uiSrc.indexOf('function Builder', from));
  assert.ok(body.includes("const showing = preview?.variant?.id"));
  assert.ok(body.includes('showing !== sel'), 'staleness is derived, not guessed');
  assert.ok(body.includes("t('fn.previewLoading')"));
});

check('the dialog keeps its height while loading', () => {
  const from = uiSrc.indexOf('function VariantPicker');
  const body = uiSrc.slice(from, uiSrc.indexOf('function Builder', from));
  assert.ok(body.includes('minHeight: 120'), 'so the first load does not resize it either');
});

// A sweep for the same defect across the app found one more: the category
// member picker emptied its table before reloading it.
//
// It also found sixteen places that look identical and are correct — a probe
// of a different host, a new run's report, a different group's rows. In those
// the old value belongs to a DIFFERENT subject, so showing it would be wrong
// rather than stale. That distinction is semantic, not syntactic, which is why
// this is a check on the two known views rather than a general audit: one that
// flagged sixteen places to catch one would be ignored within a week.
console.log('\nNO BLANK-THEN-RELOAD IN THE VIEWS THAT REFRESH THEMSELVES:');

const catSrc = readFileSync(new URL('../../frontend/src/pages/CategoriesPage.jsx', import.meta.url), 'utf8');

check('the member picker keeps its list while reloading the same view', () => {
  const from = catSrc.indexOf('const load = async ()');
  const body = catSrc.slice(from, catSrc.indexOf('const shown', from));
  assert.ok(!/setObjects\(null\)/.test(body), 'clearing before the fetch is what collapsed the table');
  assert.ok(body.includes('setBusy(true)'), 'progress is shown instead of a blank');
});

check('but a change of server or kind does clear it', () => {
  // The list under a different heading would be wrong, not merely old.
  assert.ok(catSrc.includes('setServerId(v); setObjects(null)'));
  assert.ok(catSrc.includes('setKind(v); setObjects(null)'));
});

console.log('\nPREFLIGHT SAYS WHICH FAULT IT HIT:');

const runnerSrc = readFileSync(new URL('../src/services/functionRunner.js', import.meta.url), 'utf8');

check('an empty list and a stale id are different messages', () => {
  // Both read as "not found", and they need opposite fixes: one is a mapping
  // or credentials problem, the other a deleted object.
  assert.ok(runnerSrc.includes('listed no ${kind} objects at all'));
  assert.ok(runnerSrc.includes('is not among the ${list.length}'));
  assert.ok(runnerSrc.includes('list.slice(0, 3)'), 'and it shows what WAS there');
});

check('a step with nothing selected says so instead of failing as "not found"', () => {
  assert.ok(runnerSrc.includes('has no ${kind} object selected'));
  const guard = runnerSrc.indexOf('if (!targetId)');
  const call = runnerSrc.indexOf('await wmspanel[ops.get]');
  assert.ok(guard > 0 && guard < call, 'and it does not call WMSPanel to find that out');
});

console.log('\nVARIANT DRIFT:');

function variantDrift(steps, variant) {
  const out = [];
  for (const [idx, over] of Object.entries(variant?.overrides || {})) {
    const step = steps[Number(idx)];
    if (!step) { out.push({ index: Number(idx), kind: 'noStep' }); continue; }
    const base = step.patch || {};
    for (const key of Object.keys(over || {})) {
      if (!(key in base)) out.push({ index: Number(idx), key, kind: 'orphanField' });
    }
  }
  return out;
}

check('an override for a field the step no longer sends is flagged', () => {
  const steps = [{ type: 'patch', patch: { video_source: { id: 'A' } } }];
  const v = { overrides: { 0: { video_source: { id: 'B' }, audio_source: { id: 'B' } } } };
  assert.deepEqual(variantDrift(steps, v), [{ index: 0, key: 'audio_source', kind: 'orphanField' }]);
});

check('an override for a step that was removed is flagged', () => {
  assert.deepEqual(variantDrift([], { overrides: { 2: { x: 1 } } }), [{ index: 2, kind: 'noStep' }]);
});

check('a variant that merely differs in value is NOT flagged', () => {
  // Differing is the entire purpose; flagging it would make the warning
  // meaningless within a day.
  const steps = [{ type: 'patch', patch: { video_source: { id: 'A' } } }];
  assert.deepEqual(variantDrift(steps, { overrides: { 0: { video_source: { id: 'B' } } } }), []);
});

check('nothing is corrected automatically', () => {
  // Overwriting an override would destroy the difference the variant exists
  // to express.
  assert.ok(uiSrc.includes('export function variantDrift'));
  assert.ok(!/setOverrideObject\([^)]*base\[/.test(uiSrc), 'the step value must not be written into the variant');
  assert.ok(uiSrc.includes("t('fn.driftWarn')"), 'the operator is told instead');
});

check('the step\'s own value is shown beside the override', () => {
  assert.ok(uiSrc.includes("t('fn.variantBaseIs')"), 'the comparison is made where it is edited');
});

console.log('\nPICKING AN OBJECT KEEPS ITS ID:');

check('the id and the label are written in one update', () => {
  // Two set() calls in one handler both read the same `step` prop, so the
  // second discarded the first: the label stuck, the id did not, and the panel
  // showed "SELECTED cct_feeds/feed1" beside an empty targetId while every run
  // failed preflight on every step.
  assert.ok(uiSrc.includes('const setMany'));
  assert.ok(uiSrc.includes('setMany({ targetId: String(o.id), targetLabel: label })'));
  assert.ok(!/set\('targetId'[^)]*\);\s*set\('targetLabel'/.test(uiSrc), 'the paired write must be gone');
});

check('the lost-write shape is what actually loses data', () => {
  // Reproduced rather than asserted: two writes off one stale value.
  let step = { targetId: '', targetLabel: '' };
  const stale = { ...step };
  const set = (k, v) => { step = { ...stale, [k]: v }; };
  set('targetId', 'X'); set('targetLabel', 'L');
  assert.equal(step.targetId, '', 'this is the bug');
  assert.equal(step.targetLabel, 'L');

  const setMany = (patch) => { step = { ...stale, ...patch }; };
  setMany({ targetId: 'X', targetLabel: 'L' });
  assert.equal(step.targetId, 'X', 'and this is the fix');
  assert.equal(step.targetLabel, 'L');
});

console.log('\nA STEP THAT CANNOT RUN IS CAUGHT ON SAVE:');

check('a step with no object is named, with its index', () => {
  // It saved cleanly and failed preflight on the live fleet — the worst place
  // to learn it, and exactly what happened when a lost write dropped every
  // targetId.
  const bad = incompleteSteps([
    { type: 'patch', serverId: 'S1', targetId: 'abc', label: 'ok' },
    { type: 'patch', serverId: 'S1', targetId: '', label: 'Switch sources' },
    { type: 'action', serverId: '', targetId: 'x', label: 'no server' },
  ]);
  assert.deepEqual(bad, [
    { index: 1, label: 'Switch sources', reason: 'noTarget' },
    { index: 2, label: 'no server', reason: 'noServer' },
  ]);
});

check('whitespace is not an object id', () => {
  assert.equal(incompleteSteps([{ type: 'patch', serverId: 'S1', targetId: '   ' }])[0].reason, 'noTarget');
});

check('a delay step needs neither', () => {
  assert.deepEqual(incompleteSteps([{ type: 'delay', waitSec: 5 }]), []);
});

check('it reports rather than refuses', () => {
  // Building a function over two sittings is normal; running one that cannot
  // work is not. The save succeeds and says what is missing.
  assert.ok(routeSrc.includes('incomplete: incompleteSteps('));
  assert.ok(!/return res\.status\(400\)[^;]*incomplete/.test(routeSrc));
});

check('the builder applies the same rule live', () => {
  assert.ok(uiSrc.includes("st.type !== 'delay' && (!st.serverId || !String(st.targetId || '').trim())"));
  assert.ok(uiSrc.includes("t('fn.needsPick')"), 'and marks the step itself, findable in a long list');
});

console.log('\nAN UPDATE THAT FAILED IS VISIBLE:');

const fleetSrc2 = readFileSync(new URL('../src/routes/agentFleet.js', import.meta.url), 'utf8');
const centreSrc = readFileSync(new URL('../../frontend/src/components/AgentCentreModal.jsx', import.meta.url), 'utf8');

check('the last update attempt is reported, whatever its outcome', () => {
  // A refused update looked identical to one nobody had asked for: the agent
  // simply stayed on its old version with no explanation.
  assert.ok(fleetSrc2.includes('lastUpdate:'));
  assert.ok(fleetSrc2.includes("['done', 'failed', 'expired'].includes(x.status)"));
});

check('the reason the agent gave is shown', () => {
  assert.ok(centreSrc.includes("s.lastUpdate?.status === 'failed'"));
  assert.ok(centreSrc.includes('s.lastUpdate.error'));
  assert.ok(centreSrc.includes("s.lastUpdate?.status === 'expired'"), 'and "nobody picked it up" is its own case');
});

console.log('\nTELLING FIFTEEN STEPS APART (v0.43.0):');

const fnPage = readFileSync(new URL('../../frontend/src/pages/FunctionsPage.jsx', import.meta.url), 'utf8');
const css2 = readFileSync(new URL('../../frontend/src/styles.css', import.meta.url), 'utf8');

check('the colour encodes what a step does, not what it acts on', () => {
  // The question asked of a long list is "which of these stops something".
  // Which object it acts on is already spelled out beside it, so colouring by
  // object kind would spend the one signal available on the answer already
  // given.
  assert.ok(fnPage.includes('const STEP_TONE = {'));
  const tone = fnPage.slice(fnPage.indexOf('const STEP_TONE = {'), fnPage.indexOf('const stepTone'));
  for (const k of ['pause', 'restart', 'resume', 'patch', 'delay']) assert.ok(tone.includes(`${k}:`), k);
  assert.ok(!/outgoing:|republish:|live_pull:/.test(tone), 'not by object kind');
});

check('pausing and resuming do not look the same', () => {
  // Opposite consequences, and they were the same grey badge.
  const tone = fnPage.slice(fnPage.indexOf('const STEP_TONE = {'), fnPage.indexOf('const stepTone'));
  assert.ok((tone.match(/var\(--warn\)/g) || []).length >= 2, 'pause and restart read as consequential');
  assert.ok(tone.includes("resume: 'var(--ok)'"));
});

check('the header carries order, verb and target', () => {
  // In the order they are looked for. It was a text field and a grey badge
  // reading `action:outgoing:restart`, fifteen times over.
  for (const k of ['step-no', 'step-verb', 'step-target']) assert.ok(fnPage.includes(k), k);
  assert.match(css2, /\.step-no[^}]*min-width/, 'the ordinals form a column rather than drifting right past nine');
});

check('steps fold, one at a time and all at once', () => {
  assert.ok(fnPage.includes('const [folded, setFolded]'));
  assert.ok(fnPage.includes("t('fn.foldAll')") && fnPage.includes("t('fn.unfoldAll')"));
  assert.ok(fnPage.includes('collapsed ? null : ('));
});

check('order can be changed where the steps are', () => {
  // Order is what a function does, and changing it meant deleting a step and
  // re-adding it further down the page.
  // The handler gained the variant remap in v0.43.1, so it no longer opens
  // straight into setSteps.
  assert.ok(fnPage.includes('onMove={(dir) => {'));
  assert.ok(fnPage.includes('if (to < 0 || to >= steps.length) return;'));
  assert.ok(fnPage.includes('disabled={index === 0}'));
  assert.ok(fnPage.includes('disabled={index === total - 1}'));
});

console.log('\nOVERRIDES MOVE WITH THEIR STEPS (v0.43.1):');

// Overrides are keyed by step POSITION, so any change to the order or number
// of steps re-points every override after it. Deleting the third of six left
// the fourth variant's values on what had been the fifth — reported as
// "drifted", which was true and unexplainable — and left an override for a
// position that no longer existed, which is why a variant showed six values
// against five steps.
const remap = (overrides, fn) => {
  const next = {};
  for (const [k, v] of Object.entries(overrides)) {
    const to = fn(Number(k));
    if (to != null) next[String(to)] = v;
  }
  return next;
};
const six = { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e', 5: 'f' };

check('deleting a step takes its override and closes the gap', () => {
  // Not just dropping the one: everything below it moves up, and leaving them
  // where they were is what attached values to the wrong steps.
  assert.deepEqual(remap(six, k => (k === 2 ? null : (k > 2 ? k - 1 : k))),
    { 0: 'a', 1: 'b', 2: 'd', 3: 'e', 4: 'f' });
});

check('reordering swaps exactly two', () => {
  // Reordering was added in v0.43.0 and is the worse case: it re-points
  // overrides without changing the count, so nothing looks wrong at all.
  assert.deepEqual(remap(six, k => (k === 1 ? 2 : (k === 2 ? 1 : k))),
    { 0: 'a', 1: 'c', 2: 'b', 3: 'd', 4: 'e', 5: 'f' });
});

check('a duplicated step inherits no values', () => {
  // A variant names the fields it differs in; inheriting them would give the
  // new step values nobody chose for it.
  assert.deepEqual(remap({ 0: 'a', 1: 'b', 2: 'c' }, k => (k > 0 ? k + 1 : k)),
    { 0: 'a', 2: 'b', 3: 'c' });
});

check('all three mutations remap, not just deletion', () => {
  const page = readFileSync(new URL('../../frontend/src/pages/FunctionsPage.jsx', import.meta.url), 'utf8');
  // The declaration is `const remapVariants = (fn) =>`, so it does not match
  // the call shape — the three calls are what is being counted.
  assert.equal((page.match(/remapVariants\(k =>/g) || []).length, 3,
    'called on remove, move and duplicate');
  assert.ok(page.includes('const remapVariants = (fn) =>'), 'and declared once');
});

check('stale values can be dropped, and only the stale ones', () => {
  // They cannot be repaired automatically — there is no way to know which step
  // they were meant for — but they can be removed, and removing them is what
  // makes the badge mean something again.
  const steps = [{ patch: { a: 1, b: 2 } }, { patch: { c: 3 } }];
  const overrides = { 0: { a: 9, gone: 9 }, 1: { c: 9 }, 5: { x: 9 } };
  const cleaned = Object.fromEntries(Object.entries(overrides).map(([k, over]) => {
    const step = steps[Number(k)];
    if (!step) return null;
    const kept = Object.fromEntries(Object.entries(over).filter(([f]) => f in (step.patch || {})));
    return Object.keys(kept).length ? [k, kept] : null;
  }).filter(Boolean));
  assert.deepEqual(cleaned, { 0: { a: 9 }, 1: { c: 9 } });
});

console.log('\nREADING A LIST OF STEPS (v0.44.0):');

const fnPage2 = readFileSync(new URL('../../frontend/src/pages/FunctionsPage.jsx', import.meta.url), 'utf8');
const css3 = readFileSync(new URL('../../frontend/src/styles.css', import.meta.url), 'utf8');

check('a step is numbered in words, not just digits', () => {
  assert.ok(fnPage2.includes("t('fn.stepNo', { n: index + 1 })"));
  assert.match(css3, /\.step-no[^}]*min-width:\s*62px/, 'wide enough for the word, so they still form a column');
});

check('open steps are spaced, folded ones are not', () => {
  // The gap separates blocks of controls. A folded step has none, and spacing
  // them the same makes a scannable list sparse for no reason.
  assert.match(css3, /\.step \{[^}]*margin-bottom:\s*18px/);
  assert.match(css3, /\.step:not\(:has\(\.step-body\)\) \{[^}]*margin-bottom:\s*6px/);
});

check('the preset palette is grouped by what the step acts on', () => {
  // Twenty-seven buttons in one row is a wall to read every time. Grouped from
  // the step's own objectKind, so a preset added later lands in its group
  // without anyone maintaining a list.
  assert.ok(fnPage2.includes("p.step?.objectKind || (p.step?.type === 'delay'"));
  assert.ok(fnPage2.includes("const ORDER = ['incoming', 'udp', 'outgoing'"));
});

check('every preset lands in a named group', () => {
  // A group with no name renders an empty heading, and its buttons vanish from
  // the palette.
  const kinds = [...fnPage2.matchAll(/step: \{ type: '(\w+)'(?:, objectKind: '(\w+)')?/g)]
    .map(m => m[2] || 'other');
  assert.ok(kinds.length > 20, 'the presets were found at all');
  const named = new Set(['incoming', 'udp', 'outgoing', 'republish', 'live_pull',
                         'hotswap', 'transcoder', 'other']);
  for (const k of new Set(kinds)) assert.ok(named.has(k), k);
  const i18n = readFileSync(new URL('../../frontend/src/i18n.jsx', import.meta.url), 'utf8');
  for (const k of new Set(kinds)) assert.ok(i18n.includes(`'fn.g.${k}'`), `fn.g.${k}`);
});

check('the insert button pulses only while a choice is waiting', () => {
  // Picking a stream changes nothing until it is pressed, so the moment worth
  // marking is exactly that gap. A button that always pulses is one nobody
  // sees after a day.
  assert.ok(fnPage2.includes("className={pick.includes('/') ? 'pending' : ''}"));
  assert.match(css3, /button\.pending[^}]*animation/);
  assert.ok(css3.includes('prefers-reduced-motion'), 'and it stops for anyone who finds motion difficult');
  assert.match(css3, /button\.pending[^}]*border-color/, 'the border still reads as active without motion');
});

console.log('\nCOPYING A PUSH DESTINATION (v0.53.0):');

const fp = readFileSync(new URL('../../frontend/src/pages/FunctionsPage.jsx', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../src/services/functionRunner.js', import.meta.url), 'utf8');

check('a step can change where a push goes', () => {
  // There was only a step for what a push TAKES. Where it goes is the other
  // half and the one that changes between events.
  assert.ok(fp.includes("key: 'fn.p.switchRepublishDest'"));
  for (const f of ['dest_addr', 'dest_port', 'dest_app', 'dest_strm',
                   'dest_app_params', 'dest_strm_params']) {
    assert.ok(fp.includes(f), f);
  }
});

check('the destination can be copied from a rule that already works', () => {
  // Typed by hand it is six fields including a stream key sixty characters
  // long — and a step pushing to a mistyped destination reports success,
  // because the rule was changed exactly as asked.
  assert.ok(fp.includes("t('fn.copyDestFrom')"));
  assert.ok(fp.includes('const rule = (destRules || []).find(r => r.id === id)'));
});

check('copying takes the destination and nothing else', () => {
  // Bringing the source along would make it a different step than the one
  // chosen.
  const at = fp.indexOf('applyPatchText(JSON.stringify({');
  const call = fp.slice(at, fp.indexOf('}));', at));
  assert.ok(call.includes('dest_addr'));
  assert.ok(!call.includes('src_app') && !call.includes('src_strm'));
});

check('the rules are fetched only by the step that uses them', () => {
  // Every step fetching every family would be one request per step on a
  // function with fifteen.
  assert.ok(fp.includes("const wantsDest = step.type === 'patch' && step.objectKind === 'republish'"));
  assert.ok(fp.includes('if (!wantsDest || !step.serverId) { setDestRules(null); return; }'));
});

check('the runner has a route for what the step writes', () => {
  // A step whose fields no backend applies is a step that reports success and
  // changes nothing — the failure this project keeps finding in other shapes.
  assert.ok(runner.includes("republish: { get: 'republishList', put: 'republishUpdate'"));
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall function-variant checks passed');
process.exit(fail ? 1 : 0);
