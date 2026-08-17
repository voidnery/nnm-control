// The LL-HLS rules, and the copies of them.
//
// `backend/src/services/llhls.js` is where these numbers live and where each
// one names its source. The two reconnaissance tools cannot import it — they
// are copied to machines with no repository around them — so they carry their
// own copies, and a copy is a thing that drifts.
//
// The floor drifted before anybody typed it twice: the published API reference
// says 250 ms, the live server refuses anything under 500. If a future edit
// fixes one file and not the others, this fails.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rules = await import(join(here, '..', 'src', 'services', 'llhls.js'));
const recon = await import(join(here, '..', 'tools', 'wms-apps-recon.mjs'));
const probe = await import(join(here, '..', 'tools', 'wms-app-write-probe.mjs'));

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('LL-HLS rules\n');

// --- the copies -------------------------------------------------------------

test('both tools carry the same part floor as the panel', () => {
  assert.equal(recon.PART_MIN_MS, rules.PART_MIN_MS,
    'wms-apps-recon.mjs disagrees with services/llhls.js about the floor');
  assert.equal(probe.PART_MIN_MS, rules.PART_MIN_MS,
    'wms-app-write-probe.mjs disagrees with services/llhls.js about the floor');
});

test('both tools compute the same ceiling as the panel, across chunk sizes', () => {
  for (const chunk of [0.4, 1, 2, 6, 10, 100]) {
    const expected = rules.partCeilingMs(chunk);
    assert.equal(recon.partCeilingMs(chunk), expected, `recon disagrees at chunk ${chunk}`);
    assert.equal(probe.partCeilingMs(chunk), expected, `probe disagrees at chunk ${chunk}`);
  }
});

test('the floor is the measured 500, not the 250 the reference publishes', () => {
  assert.equal(rules.PART_MIN_MS, 500,
    'the API reference says 250 and the server refuses it — the server decides');
});

// --- what follows from the two bounds ---------------------------------------

test('a chunk under a second leaves no legal part at all', () => {
  assert.equal(rules.partRangeMs(0.6), null);
  assert.equal(rules.partRangeMs(0.9), null);
  assert.equal(rules.MIN_CHUNK_SECONDS, 1);
});

test('at exactly one second the only legal part is the floor', () => {
  assert.deepEqual(rules.partRangeMs(1), { min: 500, max: 500 });
  assert.ok(rules.partIsLegal(500, 1));
  assert.ok(!rules.partIsLegal(501, 1));
  assert.ok(!rules.partIsLegal(499, 1));
});

test('the fleet\'s 6-second chunk allows the vendor\'s recommended part', () => {
  // The claim this replaces said a 6 s chunk had to come down to 2. The vendor
  // recommends 6 with a 2000 ms part, and 2000 is inside the range.
  assert.deepEqual(rules.partRangeMs(6), { min: 500, max: 3000 });
  assert.ok(rules.partIsLegal(rules.RECOMMENDED.partMs, rules.RECOMMENDED.chunkSeconds),
    'the vendor\'s own recommendation does not pass our own rules');
});

test('a missing or nonsensical chunk is a missing answer, not a zero', () => {
  assert.equal(rules.partCeilingMs(undefined), null);
  assert.equal(rules.partCeilingMs(0), null);
  assert.equal(rules.partCeilingMs(-6), null);
  assert.equal(rules.partRangeMs(undefined), null);
});

// --- latency ----------------------------------------------------------------

test('hold-back is three times the part, as Nimble\'s own playlists show', () => {
  // 0.512 → 1.536, 1 → 3, 1.001 → 3.003 in the vendor's published examples.
  assert.equal(rules.holdBackMs(512), 1536);
  assert.equal(rules.holdBackMs(1000), 3000);
});

test('latency is quoted where the vendor states it and null where it does not', () => {
  assert.equal(rules.expectedLatency(2000).source, 'vendor');
  assert.equal(rules.expectedLatency(2000).seconds, '~6');
  const between = rules.expectedLatency(750);
  assert.equal(between.seconds, null, 'a number was invented between the vendor\'s points');
  assert.equal(between.holdBackMs, 2250, 'the derived hold-back should still be given');
});

// --- containers -------------------------------------------------------------

test('plain HLS alone draws the fMP4 recommendation, which is the fleet\'s case', () => {
  const a = rules.containerAdvice(['HLS', 'RTMP']);
  assert.equal(a.ok, true, 'it is legal, just not what the vendor recommends for video');
  assert.match(a.reason, /HLS_FMP4/);
});

test('fMP4 present draws no complaint', () => {
  assert.deepEqual(rules.containerAdvice(['HLS', 'HLS_FMP4', 'RTMP']), { ok: true, reason: null });
});

test('the forbidden pair is refused and the empty case is not applicable', () => {
  assert.equal(rules.containerAdvice(['HLS', 'HLS_MPEGTS']).ok, false);
  assert.equal(rules.containerAdvice(['RTMP']).ok, false);
  assert.equal(rules.containerAdvice([]).ok, false);
});

// --- what a write actually stores -------------------------------------------

test('fMP4 replaces plain HLS rather than joining it, as measured', () => {
  assert.deepEqual(rules.protocolsAfterWrite(['HLS', 'DASH', 'SLDP', 'HLS_FMP4']),
    ['DASH', 'SLDP', 'HLS_FMP4'],
    'the reference says these combine; the server dropped HLS and said Ok');
});

test('a set without fMP4 is stored as sent', () => {
  assert.deepEqual(rules.protocolsAfterWrite(['HLS', 'RTMP', 'DASH']), ['HLS', 'RTMP', 'DASH']);
});

test('switching container is recorded as an interruption, not a link migration', () => {
  // Measured with a confirmed restart: the master held, the variant was
  // renamed. The panel's published link needs no change; the stream needs a
  // restart, and so does putting it back.
  assert.equal(rules.CONTAINER_SWITCH.entryPathMoves, false);
  assert.equal(rules.CONTAINER_SWITCH.variantPathMoves, true);
  assert.equal(rules.CONTAINER_SWITCH.requiresInputRestart, true);
  assert.equal(rules.CONTAINER_SWITCH.revertRequiresAnotherRestart, true,
    'a revert that leaves the output on the new container would read as done');
});

test('the advice says switching, not adding, because that is what happens', () => {
  const a = rules.containerAdvice(['HLS', 'RTMP']);
  assert.match(a.reason, /REMOVES/,
    'the panel would offer to add a container and silently take one away');
});

// --- the things the panel cannot do -----------------------------------------

test('the restart requirement is recorded rather than assumed away', () => {
  assert.equal(rules.RESTART_REQUIRED_AFTER_ENABLE, true,
    'a write that has not taken effect must not be reported as done');
});

test('keyframe guidance is carried as the vendor\'s examples, not as a formula', () => {
  // A rule was not derivable: at a 6 s chunk a 1000 ms part allows 1, 2, 3 and
  // a 2000 ms part also allows 6. Inventing the general case would be wrong at
  // the third one.
  assert.equal(rules.KEYFRAME_EXAMPLES.length, 2);
  assert.deepEqual(rules.KEYFRAME_EXAMPLES[0].validIntervalsSeconds, [1, 2, 3]);
  assert.deepEqual(rules.KEYFRAME_EXAMPLES[1].validIntervalsSeconds, [1, 2, 3, 6]);
  assert.ok(!('keyframeIntervalsFor' in rules),
    'a formula was added where the vendor gave only examples');
});

// --- the verdicts the recon tool reaches, now that the floor moved ----------

test('the recon tool blocks a sub-second chunk and passes a 6-second one', () => {
  assert.equal(recon.assess({ chunk_duration: 0.6, protocols: ['HLS'], alhls_enabled: false }).verdict,
    'blocked by chunk');
  assert.equal(recon.assess({ chunk_duration: 6, protocols: ['HLS'], alhls_enabled: false }).verdict,
    'off, can be turned on');
});

test('the recon tool no longer complains about the recommended setting', () => {
  const a = recon.assess({ chunk_duration: 6, protocols: ['HLS', 'HLS_FMP4'],
                           alhls_enabled: true, hls_part_duration: 2000 });
  assert.ok(!a.notes.some(n => /not low latency/.test(n)),
    'the vendor\'s recommended configuration is still being warned about');
  assert.ok(a.notes.some(n => /HOLD-BACK 6s/.test(n)),
    'the hold-back that replaced the complaint is not reported');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall LL-HLS rule checks passed');
process.exit(failures ? 1 : 0);
