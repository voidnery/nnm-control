// The viewer-side probe, and the copy of the reader inside it.
//
// Two things get checked here. The parser copy must agree with
// `backend/src/services/playlistProbe.js` on the same fixtures, because a copy
// is a thing that drifts. And the probe must reach *different* conclusions
// about an edge that serves both containers side by side, one that swaps them,
// and one with no stream at all — a probe that says the same thing in all
// three measures nothing.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, '..', 'tools', 'wms-playback-probe.mjs');
const tool = await import(TOOL);
const service = await import(join(here, '..', 'src', 'services', 'playlistProbe.js'));

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};
const testAsync = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('Playback probe\n');

// --- fixtures ---------------------------------------------------------------

const master = (variant) => `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080
${variant}?nimblesessionid=7
`;
const MASTER = master('video.m3u8');

const TS_MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:120
#EXTINF:6.000,
v_1_120.ts?nimblesessionid=7
#EXTINF:6.000,
v_1_121.ts?nimblesessionid=7
`;

// Softvelum's own published shape, trimmed.
const FMP4_LL_MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="video.fmp4?nimblesessionid=7"
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:1300
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.536
#EXT-X-PART-INF:PART-TARGET=0.512
#EXTINF:6,
v_80_7801992_1300.fmp4?nimblesessionid=7
#EXT-X-PART:DURATION=0.512,URI="v_80_7807992_1301_0.fmp4?nimblesessionid=7"
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="v_80_7807992_1301_1.fmp4?nimblesessionid=7"
`;

// Two fixtures that isolate a single container signal each. Without them the
// drift check passed while the copy's container logic was rewritten: every
// other fixture carries BOTH an EXT-X-MAP and an .fmp4 extension, so dropping
// either branch changed nothing. A comparison is only as good as the cases it
// compares on.
const MAP_ONLY = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MAP:URI="video.init?nimblesessionid=7"
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:5
#EXTINF:6,
v_5?nimblesessionid=7
`;

const M4S_ONLY = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:5
#EXTINF:6,
v_5.m4s?nimblesessionid=7
`;

// --- the copy ---------------------------------------------------------------

test('the tool\'s reader agrees with the panel\'s on every fixture', () => {
  for (const [name, text] of [['master', MASTER], ['ts', TS_MEDIA], ['fmp4-ll', FMP4_LL_MEDIA],
                              ['map-only', MAP_ONLY], ['m4s-only', M4S_ONLY],
                              ['garbage', 'not a playlist at all'], ['empty', '']]) {
    assert.deepEqual(tool.parsePlaylist(text), service.parsePlaylist(text),
      `the copy in wms-playback-probe.mjs disagrees with playlistProbe.js on ${name}`);
  }
});

// --- what the reader reads --------------------------------------------------

test('MPEG-TS and fMP4 are told apart by what the playlist says, not by guessing', () => {
  assert.equal(tool.parsePlaylist(TS_MEDIA).container, 'mpegts');
  assert.equal(tool.parsePlaylist(FMP4_LL_MEDIA).container, 'fmp4');
  assert.equal(tool.parsePlaylist(FMP4_LL_MEDIA).initSegment, 'video.fmp4?nimblesessionid=7');
});

test('each container signal is enough on its own', () => {
  // An initialisation segment with segments that carry no extension at all.
  assert.equal(tool.parsePlaylist(MAP_ONLY).container, 'fmp4');
  assert.deepEqual(tool.parsePlaylist(MAP_ONLY).segmentExtensions, []);
  // And the reverse: a recognisable extension with no EXT-X-MAP.
  assert.equal(tool.parsePlaylist(M4S_ONLY).container, 'fmp4');
  assert.equal(tool.parsePlaylist(M4S_ONLY).initSegment, null);
});

test('LL-HLS is confirmed only when parts are actually there', () => {
  assert.equal(tool.parsePlaylist(FMP4_LL_MEDIA).lowLatency.confirmed, true);
  assert.equal(tool.parsePlaylist(FMP4_LL_MEDIA).lowLatency.holdBack, 1.536);
  // The silent fallback: same stream, same container, no parts. This is what a
  // player without HTTP/2 gets, and it is the case that must not read as
  // success.
  assert.equal(tool.parsePlaylist(TS_MEDIA).lowLatency.confirmed, false);
});

test('a playlist announcing server control but emitting no parts is not confirmed', () => {
  const claimsOnly = FMP4_LL_MEDIA.split('\n').filter(l => !l.startsWith('#EXT-X-PART:')).join('\n');
  assert.equal(tool.parsePlaylist(claimsOnly).lowLatency.canBlockReload, true);
  assert.equal(tool.parsePlaylist(claimsOnly).lowLatency.confirmed, false,
    'a declaration was accepted in place of a part');
});

test('variant URIs keep their query string', () => {
  const p = tool.parsePlaylist(MASTER);
  assert.deepEqual(p.uris, ['video.m3u8?nimblesessionid=7']);
});

// --- stub edges -------------------------------------------------------------

function edge({ mode, sequence = () => 120, phaseOf = () => false }) {
  const hits = [];
  return createServer((req, res) => {
    const p = req.url.split('?')[0];
    hits.push(p);
    const seqNow = sequence();
    const send = (body, type) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    if (mode === 'no-stream') { res.writeHead(404); return res.end('not found'); }
    if (p === '/nnm-probe/s/playlist.m3u8') {
      // What NimbleRU-6 did: MPEG-TS is served at chunks.m3u8 and fMP4 at
      // video.m3u8, so switching container renames the variant behind an
      // unchanged master.
      const v = mode === 'swapped' || (mode === 'renames-variant' && phaseOf())
        ? 'video.m3u8' : 'chunks.m3u8';
      return send(master(v), 'application/vnd.apple.mpegurl');
    }
    if (p === '/nnm-probe/s/chunks.m3u8')
      return send(TS_MEDIA.replace(/#EXT-X-MEDIA-SEQUENCE:\d+/, `#EXT-X-MEDIA-SEQUENCE:${seqNow}`),
        'application/vnd.apple.mpegurl');
    if (p === '/nnm-probe/s/video.m3u8')
      return send(FMP4_LL_MEDIA.replace(/#EXT-X-MEDIA-SEQUENCE:\d+/, `#EXT-X-MEDIA-SEQUENCE:${seqNow}`),
        'application/vnd.apple.mpegurl');
    if (p === '/nnm-probe/s/video_fmp4.m3u8' && mode === 'side-by-side')
      return send(FMP4_LL_MEDIA, 'application/vnd.apple.mpegurl');
    if (p === '/nnm-probe/s/manifest.mpd' && mode !== 'hls-only')
      return send('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>', 'application/dash+xml');
    res.writeHead(404); res.end('not found');
  });
}

const clean = () => {
  for (const f of readdirSync(join(here, '..', 'tools')))
    if (/^wms-playback-\d{4}-\d{2}-\d{2}\.txt$/.test(f)) unlinkSync(join(here, '..', 'tools', f));
};

async function run(mode, args = []) {
  const s = edge({ mode });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [TOOL, base, 'nnm-probe', 's', ...args], {},
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
  s.close(); clean();
  return r;
}

await testAsync('an application with no stream is reported as no evidence', async () => {
  const r = await run('no-stream');
  assert.match(r.stdout, /not evidence about paths or containers/);
  assert.doesNotMatch(r.stdout, /pathUnverified flag on it can go/,
    'a 404 fleet was allowed to confirm the DASH path');
});

await testAsync('a live application is read, and the DASH path gets confirmed', async () => {
  const r = await run('side-by-side');
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /HLS master.*200 master, 1 variant/s);
  assert.match(r.stdout, /200 MPD/);
  assert.match(r.stdout, /pathUnverified flag on it can go/);
});

await testAsync('an application without DASH does not get its path confirmed', async () => {
  const r = await run('hls-only');
  assert.match(r.stdout, /did not answer/);
  assert.doesNotMatch(r.stdout, /pathUnverified flag on it can go/);
});

await testAsync('the container the edge actually serves is named in the report', async () => {
  const ts = await run('hls-only');
  assert.match(ts.stdout, /container=mpegts/);
  const fm = await run('swapped');
  assert.match(fm.stdout, /container=fmp4/);
  assert.match(fm.stdout, /LL-HLS parts=1 target=0.512s hold-back=1.536s/);
});

await testAsync('a read-only run says what the write half would add', async () => {
  const r = await run('side-by-side');
  assert.match(r.stdout, /Read-only run/);
  assert.match(r.stdout, /--enable-fmp4 --write/);
});

// --- the guard --------------------------------------------------------------

// --- the write half, against a stub that answers both roles -----------------

function wmsStub({ sticks, replaces = false, phase = {} }) {
  const app = { id: 'p1', application: 'nnm-probe', chunk_duration: 6, protocols: ['HLS', 'DASH'] };
  const writes = [];
  return createServer((req, res) => {
    const p = req.url.split('?')[0];
    const ok = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (p === '/v1/server/s1/live/app' && req.method === 'GET') return ok({ status: 'Ok', applications: [app] });
    if (p === '/v1/server/s1/live/app/p1' && req.method === 'GET') return ok({ status: 'Ok', application: app });
    if (p === '/v1/server/s1/live/app/p1' && req.method === 'PUT') {
      let b = ''; req.on('data', c => b += c);
      return req.on('end', () => {
        const patch = JSON.parse(b || '{}');
        writes.push(patch);
        if (patch.protocols?.includes('HLS_FMP4')) phase.written = true;
        // `sticks: false` is the case that matters: the API says Ok and the
        // object does not change. Accepted is not applied.
        if (sticks) {
          Object.assign(app, patch);
          // What the live server did: HLS_FMP4 took plain HLS's place instead
          // of joining it, and the API still said Ok.
          if (replaces && Array.isArray(app.protocols) && app.protocols.includes('HLS_FMP4'))
            app.protocols = app.protocols.filter(x => x !== 'HLS');
        }
        ok({ status: 'Ok', application: app });
      });
    }
    res.writeHead(404); res.end('no');
  });
}

async function runWrite({ mode, sticks, replaces = false, sequences = [120, 121] }) {
  // Switch on the PUT, not on a clock and not on a request count.
  //
  // Counting calls put both censuses on the same value, so the check could not
  // fail. A 1.5-second clock then raced the run — the second census landed at
  // about 1.4s and read the first value. The PUT is the actual boundary
  // between the two censuses, and the WMSPanel stub knows exactly when it
  // happened.
  const phase = { written: false };
  const e = edge({ mode, sequence: () => (phase.written ? sequences[1] : sequences[0]),
                   phaseOf: () => phase.written });
  const w = wmsStub({ sticks, replaces, phase });
  await new Promise(r => e.listen(0, '127.0.0.1', r));
  await new Promise(r => w.listen(0, '127.0.0.1', r));
  const r = await new Promise((resolve) => {
    execFile(process.execPath,
      [TOOL, `http://127.0.0.1:${e.address().port}`, 'nnm-probe', 's',
       '--enable-fmp4', '--write', '--wait=1',
       '--client-id=c', '--api-key=k', '--server=s1'],
      { env: { ...process.env, WMS_BASE: `http://127.0.0.1:${w.address().port}/v1` } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
  e.close(); w.close(); clean();
  return r;
}

await testAsync('a write the API accepts but does not apply stops the run', async () => {
  const r = await runWrite({ mode: 'hls-only', sticks: false });
  assert.notEqual(r.code, 0, 'a container change that did not stick was treated as done');
  assert.match(r.stdout, /is not in the application after the write/);
});

await testAsync('the operator is told to restart the stream, in the window', async () => {
  const r = await runWrite({ mode: 'hls-only', sticks: true });
  assert.match(r.stdout, /RESTART THE INPUT STREAM/);
  assert.match(r.stdout, /Waiting 1s/);
});

await testAsync('a stream that kept running is named as the reason nothing is settled', async () => {
  // The shape of both live runs: same paths, same container, and a media
  // sequence that went up — so the stream was never restarted and the question
  // is simply not answered.
  const r = await runWrite({ mode: 'hls-only', sticks: true, sequences: [120, 121] });
  assert.match(r.stdout, /input stream restarted: NO — it kept running/);
  assert.match(r.stdout, /THE STREAM WAS NOT RESTARTED/);
  assert.match(r.stdout, /question is not answered/);
  assert.doesNotMatch(r.stdout, /Paths disappeared/);
});

await testAsync('across a real restart, the same result becomes an answer', async () => {
  // Media sequence resets: this is a different run of the stream, so "nothing
  // moved" now means something.
  const r = await runWrite({ mode: 'hls-only', sticks: true, sequences: [900, 3] });
  assert.match(r.stdout, /input stream restarted: YES/);
  assert.match(r.stdout, /across a confirmed restart/);
  assert.match(r.stdout, /link builder needs no change/);
});

await testAsync('a stalled playlist is not rounded up to a restart', async () => {
  // The sequence never moves. An earlier version announced "across a restart"
  // on exactly this, which is the convenient answer rather than the true one.
  const r = await runWrite({ mode: 'hls-only', sticks: true, sequences: [77, 77] });
  assert.match(r.stdout, /could not tell from the media sequence/);
  assert.match(r.stdout, /Not settled/);
  assert.doesNotMatch(r.stdout, /confirmed restart/);
  assert.doesNotMatch(r.stdout, /link builder needs no change/);
});

await testAsync('a variant renamed behind an unchanged master is not a link migration', async () => {
  // The third live run, exactly: chunks.m3u8 → video.m3u8, master unchanged,
  // restart confirmed. The old wording called this "not safe without changing
  // the links". The link had not moved.
  const r = await runWrite({ mode: 'renames-variant', sticks: true, replaces: true,
                             sequences: [333, 10] });
  assert.match(r.stdout, /input stream restarted: YES/);
  assert.match(r.stdout, /unchanged — every published link still resolves/);
  assert.match(r.stdout, /variant behind them changed/);
  assert.match(r.stdout, /operation with an interruption, not a link migration/);
  assert.doesNotMatch(r.stdout, /must be reissued/);

  // The verdict can come out right while the two lists are empty and the
  // classification does nothing — which is what happened when ENTRY_PATHS was
  // emptied as a diversion and this check still passed. So assert the split
  // itself: the master is on the entry line and not on the variant line, and
  // the renamed variant is the other way round.
  const entryBlock = r.stdout.match(/entry points {2}before: (.*)\n\s+after: {2}(.*)/);
  const variantBlock = r.stdout.match(/variants {6}before: (.*)\n\s+after: {2}(.*)/);
  assert.ok(entryBlock && variantBlock, 'the two lists are not both printed');
  assert.match(entryBlock[1], /\/playlist\.m3u8/, 'the master is not counted as an entry point');
  assert.match(entryBlock[2], /\/playlist\.m3u8/);
  assert.doesNotMatch(variantBlock[1], /\/playlist\.m3u8/, 'the master was listed as a variant');
  assert.match(variantBlock[1], /chunks\.m3u8/);
  assert.match(variantBlock[2], /video\.m3u8/);
});

await testAsync('a moved entry point is still called what it is', async () => {
  // Contradiction for the check above: if the master itself moves, the verdict
  // must be the alarming one.
  const c = { found: [{ path: '/playlist.m3u8', res: { status: 200 } },
                      { path: 'chunks.m3u8', res: { status: 200 } }] };
  const d = { found: [{ path: '/playlist_v2.m3u8', res: { status: 200 } },
                      { path: 'chunks.m3u8', res: { status: 200 } }] };
  assert.deepEqual(tool.entryPathsOf(c), ['/playlist.m3u8']);
  assert.deepEqual(tool.entryPathsOf(d), [], 'an invented entry point counted as one');
  assert.deepEqual(tool.variantPathsOf(c), ['chunks.m3u8']);
  assert.notDeepEqual(tool.entryPathsOf(c), tool.entryPathsOf(d));
});

await testAsync('the restore is not claimed to be in effect before another restart', async () => {
  const r = await runWrite({ mode: 'renames-variant', sticks: true, replaces: true,
                             sequences: [333, 10] });
  assert.match(r.stdout, /THE OUTPUT IS NOT/);
  assert.match(r.stdout, /Restart the publisher once more/);
});

await testAsync('a server that swaps a container instead of adding one is caught', async () => {
  const r = await runWrite({ mode: 'hls-only', sticks: true, replaces: true });
  assert.match(r.stdout, /THE SERVER DID NOT STORE WHAT WAS SENT/);
  assert.match(r.stdout, /dropped:  HLS/);
  assert.match(r.stdout, /replacement and not an addition/);
});

await testAsync('the protocols are put back afterwards', async () => {
  const r = await runWrite({ mode: 'hls-only', sticks: true });
  assert.match(r.stdout, /Restore protocols \["HLS","DASH"\] → accepted/);
});

await testAsync('it refuses the write half without credentials rather than half-doing it', async () => {
  const r = await run('side-by-side', ['--enable-fmp4', '--write']);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout, /needs --client-id, --api-key and --server/);
});

test('the guard name is the same constant the write probe uses', () => {
  assert.equal(tool.GUARD_NAME, 'nnm-probe');
});

// --- the comparison, which is the point -------------------------------------

// The bug the first live run produced. Nimble mints a session id per request,
// so the same URL fetched twice differs — and the tool reported paths
// appearing and disappearing, and printed the verdict that existing viewers
// had been moved. Nothing had been moved.
test('a session id is not a path', () => {
  assert.equal(tool.stablePath('chunks.m3u8?nimblesessionid=1'), 'chunks.m3u8');
  assert.equal(tool.stablePath('chunks.m3u8?nimblesessionid=1'),
               tool.stablePath('chunks.m3u8?nimblesessionid=3'),
               'two reads of the same playlist still compare as different paths');
});

test('parameters that are not session ids survive the comparison', () => {
  // Stripping the whole query would hide a genuine change of path.
  assert.equal(tool.stablePath('video.m3u8?bitrate=hi&nimblesessionid=9'), 'video.m3u8?bitrate=hi');
  assert.equal(tool.stablePath('video.m3u8'), 'video.m3u8');
});

test('two censuses that differ only by session id compare as unchanged', () => {
  const census = (n) => ({ found: [
    { path: '/playlist.m3u8', res: { status: 200 } },
    { path: `chunks.m3u8?nimblesessionid=${n}`, res: { status: 200 } },
    { path: '/manifest.mpd', res: { status: 200 } },
  ] });
  assert.deepEqual(tool.pathsOf(census(1)), tool.pathsOf(census(3)));
});

test('a real path change is still seen', () => {
  const before = { found: [{ path: 'chunks.m3u8?nimblesessionid=1', res: { status: 200 } }] };
  const after = { found: [{ path: 'video_fmp4.m3u8?nimblesessionid=3', res: { status: 200 } }] };
  assert.notDeepEqual(tool.pathsOf(before), tool.pathsOf(after),
    'the fix for the session id swallowed a genuine change too');
});

test('pathsOf compares what a viewer can reach, and ignores what 404s', () => {
  const c = {
    found: [
      { path: '/playlist.m3u8', res: { status: 200 } },
      { path: 'video.m3u8?nimblesessionid=7', res: { status: 200 } },
      { path: '/manifest.mpd', res: { status: 404 } },
    ],
  };
  assert.deepEqual(tool.pathsOf(c), ['/playlist.m3u8', 'video.m3u8']);
});

test('restarted() answers three ways, and does not guess the third', () => {
  assert.equal(tool.restarted({ mediaSequence: 900 }, { mediaSequence: 3 }), true);
  assert.equal(tool.restarted({ mediaSequence: 120 }, { mediaSequence: 121 }), false);
  // A playlist that has not moved at all is a stalled stream, not an answer.
  assert.equal(tool.restarted({ mediaSequence: 5 }, { mediaSequence: 5 }), null);
  assert.equal(tool.restarted({ mediaSequence: null }, { mediaSequence: 5 }), null);
  assert.equal(tool.restarted(null, null), null);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall playback probe checks passed');
process.exit(failures ? 1 : 0);
