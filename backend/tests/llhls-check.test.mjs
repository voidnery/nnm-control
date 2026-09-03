// The delivery check, tested before it goes anywhere near a live stream.
//
// Its whole value is that it distinguishes a server doing blocking reload from
// one serving parts as decoration. A check that says the same about both
// measures nothing, so that is what these assert.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { parse, container, durationSpread, blockingVerdict, keyframeInterval, keyframeFits } =
  await import(join(here, '..', 'tools', 'llhls-check.mjs'));

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('LL-HLS delivery check\n');

const TS = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:9
#EXT-X-MEDIA-SEQUENCE:888
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=6.006
#EXT-X-PART-INF:PART-TARGET=2.002
#EXT-X-PART:DURATION=2.002,URI="l_1_0.ts"
#EXTINF:8.008,
l_1.ts
#EXTINF:4.300,
l_2.ts
`;

check('a media playlist is read, and a master is not mistaken for one', () => {
  const p = parse(TS);
  assert.equal(p.isMaster, false);
  assert.equal(p.parts, 1);
  assert.equal(p.partTarget, 2.002);
  assert.equal(p.holdBack, 6.006);
  assert.equal(p.canBlockReload, true);
  assert.equal(p.mediaSequence, 888);
  assert.equal(container(p), 'mpegts');
  assert.equal(parse('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n').isMaster, true);
});

check('fMP4 is recognised by its initialisation segment', () => {
  assert.equal(container(parse('#EXTM3U\n#EXT-X-MAP:URI="v.fmp4"\n#EXTINF:6,\nseg\n')), 'fmp4');
});

check('segments of differing length are surfaced as a spread, not a verdict', () => {
  // A keyframe interval that does not divide the chunk. Encoder-side, and it
  // changes every latency figure.
  const s = durationSpread(parse(TS).segmentDurations, 9);
  assert.equal(s.count, 2);
  assert.ok(s.spread > 3, `spread was ${s.spread}`);
});

check('a server that holds the request is called working', () => {
  const v = blockingVerdict({ baseMs: 30, blockedMs: 1830, partTarget: 2.002 });
  assert.equal(v.working, true);
  assert.ok(v.held >= 1.7);
});

check('a server that answers instantly is called not working', () => {
  // The case the whole tool exists for: parts in the text, no blocking behind
  // them, and a viewer as far back as ordinary HLS.
  const v = blockingVerdict({ baseMs: 30, blockedMs: 35, partTarget: 2.002 });
  assert.equal(v.working, false);
  assert.match(v.why, /not backed by blocking reload/);
});

check('the two verdicts differ, which is the only reason to run this', () => {
  const held = blockingVerdict({ baseMs: 30, blockedMs: 1830, partTarget: 2.002 });
  const fast = blockingVerdict({ baseMs: 30, blockedMs: 35, partTarget: 2.002 });
  assert.notEqual(held.why, fast.why);
  assert.notEqual(held.working, fast.working);
});

check('the threshold scales with the part and never goes below a floor', () => {
  // Half a part is the smallest wait that cannot be network noise.
  assert.equal(blockingVerdict({ baseMs: 0, blockedMs: 0, partTarget: 2 }).threshold, 1);
  assert.equal(blockingVerdict({ baseMs: 0, blockedMs: 0, partTarget: 0.2 }).threshold, 0.3);
});

check('a failed blocking request is unknown, not a failure of the server', () => {
  const v = blockingVerdict({ baseMs: 30, blockedMs: null, partTarget: 2 });
  assert.equal(v.held, null);
  assert.match(v.why, /request failed/);
});

// --- the arithmetic that made two runs disagree about one server -----------

const IN_PROGRESS = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA-SEQUENCE:2
#EXT-X-PART-INF:PART-TARGET=2.002
#EXTINF:6.006,
s_5.fmp4
#EXT-X-PART:DURATION=2.002,URI="p_6_0.fmp4"
#EXT-X-PART:DURATION=2.002,URI="p_6_1.fmp4"
#EXT-X-PART:DURATION=2.002,URI="p_6_2.fmp4"
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="p_6_3.fmp4"
`;

check('parts belonging to the segment in progress are counted apart', () => {
  // Asking for part 0 of that segment names a part that already exists, so a
  // correct server answers instantly — which the first version of this tool
  // read as "no blocking reload". Two runs against one server disagreed, from
  // the arithmetic rather than from the server.
  const p = parse(IN_PROGRESS);
  assert.equal(p.partsInProgress, 3);
  assert.equal(p.segmentDurations.length, 1);
});

check('the server names the part that does not exist, and that is what gets asked for', () => {
  assert.equal(parse(IN_PROGRESS).preloadHintUri, 'p_6_3.fmp4');
  // Without a hint the in-progress count gives the next index — never 0 when
  // parts have already been published for that segment.
  const noHint = parse(IN_PROGRESS.replace(/#EXT-X-PRELOAD-HINT[^\n]*\n/, ''));
  assert.equal(noHint.preloadHintUri, null);
  assert.equal(noHint.partsInProgress, 3);
});

check('a playlist whose last segment is closed has no parts in progress', () => {
  assert.equal(parse(TS).partsInProgress, 0,
    'a part before the last EXTINF was counted as belonging to the segment after it');
});

// --- the keyframe interval, read off the output ----------------------------

const PARTS = [
  { duration: 2.002, independent: true }, { duration: 2.002, independent: false },
  { duration: 2.002, independent: true }, { duration: 2.002, independent: false },
  { duration: 2.002, independent: true }, { duration: 2.002, independent: false },
];

check('the keyframe interval comes from the INDEPENDENT flags', () => {
  // Derived by hand from a live dump first: marked parts every second part of
  // 2.002 s means keyframes every 4.004 s. The tool should not need eyes.
  const kf = keyframeInterval(PARTS);
  assert.equal(kf.everyNthPart, 2);
  assert.equal(kf.seconds, 4.004);
  assert.equal(kf.steady, true);
});

check('an unsteady interval is reported as unsteady, not averaged', () => {
  const kf = keyframeInterval([
    { duration: 1, independent: true }, { duration: 1, independent: false },
    { duration: 1, independent: true }, { duration: 1, independent: false },
    { duration: 1, independent: false }, { duration: 1, independent: true },
  ]);
  assert.equal(kf.steady, false);
  assert.deepEqual(kf.gaps, [2, 3]);
});

check('no flags at all is unknown, not zero', () => {
  // Some servers omit INDEPENDENT entirely, and an absent flag is not an
  // absent keyframe.
  assert.equal(keyframeInterval([{ duration: 2, independent: false }]), null);
  assert.equal(keyframeInterval([]), null);
});

check('the fit is judged against the configured chunk, which is not in the playlist', () => {
  // The first version took the longest segment for the chunk. On this fleet's
  // own output that is 8.008 s — exactly two keyframe intervals — so it
  // declared a perfect fit about a stream whose segments were visibly
  // wandering. The configured chunk was 6.
  assert.equal(keyframeFits(4.004, 8.008).fits, true, 'two intervals do look like a fit');
  assert.equal(keyframeFits(4.004, 6).fits, false, 'and against the real chunk they are not');
  assert.equal(keyframeFits(2.002, 6).fits, true);
});

check('when it does not fit, both levers are named with the side they belong to', () => {
  const f = keyframeFits(4.004, 6);
  assert.equal(f.suggestion.keyframeSeconds, 6);
  assert.equal(f.suggestion.orChunkSeconds, 4.004);
});

check('the tool judges the fit against the given chunk, not a derived one', () => {
  // The unit checks above document the trap; this one guards the wiring.
  // Re-pointing `keyframeFits` at the longest segment changed no test until
  // this existed, which is the diversion telling us the check was missing.
  const src = readFileSync(join(here, '..', 'tools', 'llhls-check.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.match(src, /keyframeFits\(kf\.seconds, CHUNK\)/,
    'the fit is being judged against something other than the chunk that was given');
  assert.ok(!/keyframeFits\([^)]*spread/.test(src),
    'the chunk is being derived from the segment lengths again');
});

check('without a chunk nothing is concluded', () => {
  assert.equal(keyframeFits(4.004, null), null);
  assert.equal(keyframeFits(null, 6), null);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall delivery check tests passed');
process.exit(failures ? 1 : 0);
