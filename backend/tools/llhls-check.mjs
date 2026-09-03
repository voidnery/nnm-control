#!/usr/bin/env node
//
// Is this actually Low-Latency HLS, from the viewer's side.
//
// Written after three rounds of answering that question by reasoning and
// getting it wrong each time. Everything below is a measurement, and where a
// measurement cannot decide something the report says so instead of guessing.
//
// Players do not settle it. VLC has no LL-HLS at all and will play the stream
// as ordinary HLS whether parts exist or not; OBS is not an HLS player. A
// browser with hls.js can settle it, but only if its low-latency mode is on
// and its own numbers are read correctly — and the statistics dump most people
// reach for reports request latency, not distance from the live edge.
//
// So this asks the server directly. Four questions:
//
//   1. **Are parts in the playlist**, and what do they claim: PART-TARGET,
//      PART-HOLD-BACK, the version the server declares, the container.
//   2. **Does blocking reload work.** This is the mechanism. A client asks for
//      a media sequence that does not exist yet; a low-latency server holds
//      the connection until it does. A server that answers instantly is
//      serving parts as decoration.
//   3. **How far behind live** the playlist's own timestamps put a viewer.
//   4. **Are segments the length they should be.** Softvelum: a keyframe
//      interval that does not divide the chunk produces segments of 4.3, 5.0,
//      10.0 seconds instead of the configured length, and some players
//      misbehave. Encoder-side, invisible to the panel, and it changes every
//      latency number.
//
// STANDALONE: no dependencies, one file, no repository around it. Node 18 or
// later, on any platform.
//
// Usage:
//
//     node llhls-check.mjs https://edge.example.com:8443/app/stream
//     node llhls-check.mjs <url> --insecure     # self-signed / name mismatch
//
// The URL is the master playlist, exactly as a viewer would use it — by name,
// not by address, or the certificate check answers a different question.
//
const argv = process.argv.slice(2);
const INSECURE = argv.includes('--insecure');
const [TARGET] = argv.filter(a => !a.startsWith('--'));
// The chunk the application is configured with. Not in the playlist, and not
// guessable from it: the longest segment can be two keyframe intervals and
// look like a perfect fit.
const CHUNK = Number((argv.find(a => a.startsWith('--chunk=')) || '').split('=')[1]) || null;

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, `llhls-check-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`);
const IS_MAIN = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

const out = [];
const line = (s = '') => { process.stdout.write(s + '\n'); out.push(s); };
function writeReport() {
  try { writeFileSync(REPORT, out.join('\n') + '\n'); process.stderr.write(`\nwritten: ${REPORT}\n`); }
  catch (e) { process.stderr.write(`\ncould not write the report: ${e?.message || e}\n`); }
}

if (IS_MAIN && !TARGET) {
  line('usage: node llhls-check.mjs <master playlist URL> [--insecure]');
  line('');
  line('  e.g. node llhls-check.mjs https://edge.example.com:8443/app/stream/playlist.m3u8');
  line('');
  line('  Use the name a viewer uses, not an IP: a certificate checked against');
  line('  an address answers a different question than the one you are asking.');
  line('  --insecure only if you already know the certificate is wrong and are');
  line('  measuring something else.');
  line('');
  line('  --chunk=<seconds>  the chunk the application is configured with, from');
  line('                     WMSPanel. Not in the playlist; with it, this says');
  line('                     whether the keyframe interval divides it evenly.');
  process.exit(1);
}

// `--insecure` is honoured by turning off Node's verification for this process
// only, and it is reported in the output so a run cannot be quoted without it.
if (INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ---------------------------------------------------------------------------
// Reading a playlist. Exported so the tests can hold it to fixtures.
export function parse(text) {
  const body = String(text || '');
  const lines = body.split(/\r?\n/);
  const uris = lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const num = (re) => { const m = body.match(re); return m ? Number(m[1]) : null; };

  return {
    valid: /^\s*#EXTM3U/.test(body),
    version: num(/#EXT-X-VERSION:(\d+)/),
    isMaster: /#EXT-X-STREAM-INF/.test(body),
    uris,
    mediaSequence: num(/#EXT-X-MEDIA-SEQUENCE:(\d+)/),
    targetDuration: num(/#EXT-X-TARGETDURATION:(\d+)/),
    partTarget: num(/#EXT-X-PART-INF:PART-TARGET=([\d.]+)/),
    holdBack: num(/PART-HOLD-BACK=([\d.]+)/),
    canBlockReload: /CAN-BLOCK-RELOAD=YES/.test(body),
    parts: (body.match(/#EXT-X-PART:/g) || []).length,
    preloadHint: /#EXT-X-PRELOAD-HINT/.test(body),
    initSegment: (body.match(/#EXT-X-MAP:URI="([^"]+)"/) || [])[1] || null,
    // The URI of the part that does not exist yet, named by the server itself.
    // This is the canonical thing to ask for, and it removes the arithmetic
    // that got the first version of this tool wrong.
    preloadHintUri: (body.match(/#EXT-X-PRELOAD-HINT:[^\n]*URI="([^"]+)"/) || [])[1] || null,
    // Parts after the last EXTINF belong to the segment still being made, so
    // its media sequence already partly exists — asking for part 0 of it
    // returns immediately and says nothing.
    partsInProgress: (() => {
      const lastInf = body.lastIndexOf('#EXTINF');
      const tail = lastInf >= 0 ? body.slice(lastInf) : body;
      return (tail.match(/#EXT-X-PART:/g) || []).length;
    })(),
    // Every segment length in the playlist, so their spread can be looked at
    // rather than their average.
    segmentDurations: [...body.matchAll(/#EXTINF:([\d.]+)/g)].map(m => Number(m[1])),
    // Each part, with its duration and whether it starts on a keyframe.
    //
    // `INDEPENDENT=YES` marks a part that begins with one, so the gap between
    // marked parts *is* the keyframe interval — measured from the output
    // rather than asked of whoever runs the encoder. That interval is what
    // decides segment length, and mismatched segment lengths are what the
    // vendor warns about and what this fleet turned out to have.
    partList: [...body.matchAll(/#EXT-X-PART:([^\n]*)/g)].map(m => ({
      duration: Number((m[1].match(/DURATION=([\d.]+)/) || [])[1]) || null,
      independent: /INDEPENDENT=YES/.test(m[1]),
    })),
    programDateTime: (body.match(/#EXT-X-PROGRAM-DATE-TIME:(\S+)/) || [])[1] || null,
    // The last part index in the last media sequence, needed to ask for the
    // next one that does not exist yet.
    lastPartIndex: (() => {
      let idx = -1, seen = -1;
      for (const l of lines) {
        if (l.startsWith('#EXTINF')) { seen = idx; idx = -1; }
        if (l.startsWith('#EXT-X-PART:')) idx++;
      }
      return idx >= 0 ? idx : seen;
    })(),
  };
}

export function container(p) {
  if (p.initSegment) return 'fmp4';
  const exts = new Set(p.uris.map(u => (u.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1]).filter(Boolean));
  if ([...exts].some(e => ['fmp4', 'm4s', 'mp4'].includes(e))) return 'fmp4';
  if (exts.has('ts')) return 'mpegts';
  return null;
}

// The keyframe interval, read off the parts.
//
// Derived by hand from a live dump first: parts marked `INDEPENDENT=YES` came
// every second part of 2.002 s, so keyframes arrived every 4.004 s, and a
// 6-second chunk cannot be cut evenly at 4.004 — hence segments of 4.004 and
// 8.008. Doing it here means the next person does not have to squint at a
// playlist.
//
// `null` when nothing is marked: some servers omit the flag entirely, and an
// absent flag is not an absent keyframe.
export function keyframeInterval(partList) {
  const marked = partList.map((p, i) => (p.independent ? i : -1)).filter(i => i >= 0);
  if (marked.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < marked.length; i++) gaps.push(marked[i] - marked[i - 1]);
  const steady = gaps.every(g => g === gaps[0]);
  const partDur = partList[0]?.duration || null;
  return {
    everyNthPart: gaps[0],
    steady,
    seconds: partDur ? Number((gaps[0] * partDur).toFixed(3)) : null,
    gaps,
  };
}

// Does that interval divide the chunk evenly.
//
// The whole point of the warning: it does not, so Nimble cuts at whichever
// keyframe is nearest and segment lengths wander.
export function keyframeFits(intervalSeconds, chunkSeconds) {
  if (!intervalSeconds || !chunkSeconds) return null;
  const n = chunkSeconds / intervalSeconds;
  const fits = Math.abs(n - Math.round(n)) < 0.02;
  return {
    fits,
    perChunk: Number(n.toFixed(2)),
    // What to change, and on which side. The interval is the encoder's; the
    // chunk is the panel's.
    suggestion: fits ? null : {
      keyframeSeconds: Number((chunkSeconds / Math.max(1, Math.round(n))).toFixed(3)),
      orChunkSeconds: Number((intervalSeconds * Math.max(1, Math.round(n))).toFixed(3)),
    },
  };
}

// Segments that are not the length they claim.
//
// Reported as a spread rather than a verdict: one long segment at the end of a
// playlist is normal, a playlist where every length differs is a keyframe
// problem, and only somebody looking at the encoder can tell which.
export function durationSpread(durations, targetDuration) {
  if (!durations.length) return null;
  const min = Math.min(...durations), max = Math.max(...durations);
  return {
    count: durations.length, min, max,
    spread: Number((max - min).toFixed(3)),
    // The declared target is a ceiling, not the configured chunk, so this is
    // a hint and not an assertion.
    overTarget: targetDuration ? durations.filter(d => d > targetDuration).length : null,
  };
}

let calls = 0;
async function get(url, timeoutMs = 30_000) {
  calls++;
  const started = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    const text = await r.text();
    return { ok: true, status: r.status, ms: Date.now() - started, text, url,
             alpn: r.headers.get('x-firefox-spdy') || null };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - started,
             error: String(e?.message || e).slice(0, 200), url };
  }
}

const abs = (from, uri) => new URL(uri, from).toString();

// ---------------------------------------------------------------------------
// The measurement that decides it.
//
// A low-latency server holds a request for a media sequence that does not
// exist yet until it does. One that answers immediately is not doing blocking
// reload, whatever its playlist advertises — and a client would then poll, and
// a viewer would sit as far behind as ordinary HLS.
//
// Compared against a plain fetch of the same playlist in the same run, because
// "two seconds" means nothing without knowing what a normal request costs from
// where this is running.
export function blockingVerdict({ baseMs, blockedMs, partTarget }) {
  if (blockedMs === null) return { held: null, why: 'the blocking request failed' };
  const held = blockedMs - baseMs;
  // Half a part is the smallest wait that cannot be network noise. Nimble's
  // own hold is up to one part.
  const threshold = Math.max(300, (partTarget ? partTarget * 1000 : 1000) / 2);
  return {
    held: Number((held / 1000).toFixed(2)),
    threshold: Number((threshold / 1000).toFixed(2)),
    working: held >= threshold,
    why: held >= threshold
      ? 'the server held the request until the part existed — this is blocking reload, and it is what makes LL-HLS low latency'
      : 'the server answered a request for a part that does not exist yet as fast as it answers an ordinary one. The parts in the playlist are not backed by blocking reload, so a client cannot ride the live edge.',
  };
}

function describe(p) {
  const bits = [];
  bits.push(`version ${p.version ?? '—'}`);
  bits.push(`${p.parts} part tag(s)`);
  if (p.partTarget) bits.push(`PART-TARGET ${p.partTarget}s`);
  if (p.holdBack) bits.push(`PART-HOLD-BACK ${p.holdBack}s`);
  bits.push(p.canBlockReload ? 'CAN-BLOCK-RELOAD' : 'no CAN-BLOCK-RELOAD');
  if (p.preloadHint) bits.push('PRELOAD-HINT');
  bits.push(`container ${container(p) || 'unknown'}`);
  return bits.join(', ');
}

async function main() {
  line('LL-HLS delivery check');
  line(`Date: ${new Date().toISOString()}`);
  line(`Target: ${TARGET}`);
  if (INSECURE) line('TLS verification: OFF (--insecure) — certificate findings below mean nothing');
  line('');

  // Control probe first: the same host and port, with a path that cannot
  // exist. A refused connection or a certificate complaint looks identical to
  // "this stream has no playlist" without one, and those are fixed
  // differently.
  const control = await get(new URL('./__nnm_control_probe__', TARGET).toString(), 10_000);
  line(`Control: ${control.ok ? `reached, HTTP ${control.status}` : `NOT REACHED — ${control.error}`}`);
  if (!control.ok) {
    line('');
    line('Nothing answered on that host and port at all, so nothing below would');
    line('have been evidence about this stream. Check the name, the port, and');
    line('the certificate before anything else.');
    throw new Error('control probe failed');
  }
  line('');

  const master = await get(TARGET);
  if (!master.ok || master.status !== 200) {
    line(`The master playlist did not answer: ${master.status ?? master.error}`);
    line('');
    line('If this is a certificate complaint, check the name: a certificate is');
    line('issued for a hostname and an IP address is a different question.');
    throw new Error('no master');
  }
  const mp = parse(master.text);
  if (!mp.valid) { line('That URL did not return a playlist.'); throw new Error('not a playlist'); }

  // Follow the master to its variants. Parts live there, never in the master —
  // a grep of the master is how this check was got wrong by hand twice.
  const variants = mp.isMaster ? mp.uris.map(u => abs(master.url, u)) : [master.url];
  line(mp.isMaster ? `Master: ${mp.uris.length} variant(s)` : 'Media playlist given directly');
  line('');

  let decided = false;
  for (const vurl of variants) {
    const v = await get(vurl);
    const name = vurl.split('/').pop().split('?')[0];
    if (!v.ok || v.status !== 200) { line(`  ${name}: ${v.status ?? v.error}`); continue; }
    const p = parse(v.text);

    line(`=== ${name}`);
    line(`  ${describe(p)}`);

    const spread = durationSpread(p.segmentDurations, p.targetDuration);
    if (spread) {
      line(`  segments: ${spread.count}, ${spread.min}–${spread.max}s (spread ${spread.spread}s)`);
      if (spread.spread > 0.5) {
        line('  ! Segment lengths differ by more than half a second. Softvelum: a');
        line('    keyframe interval that does not divide the chunk produces segments');
        line('    of arbitrary length, and some players misbehave. That is set on the');
        line('    encoder, not here, and it changes every latency figure below.');
      }
    }

    const kf = keyframeInterval(p.partList);
    if (kf) {
      line(`  keyframes: every ${kf.everyNthPart} part(s)`
        + (kf.seconds ? ` \u2248 ${kf.seconds}s` : '')
        + (kf.steady ? '' : ` — NOT steady, gaps ${kf.gaps.join(', ')}`));
      // **The chunk is not in the playlist.** The first version of this took
      // the longest segment for it — and on the fleet's own output that is
      // 8.008 s, exactly two keyframe intervals, so the check declared a
      // perfect fit about a stream whose segments were visibly wandering. The
      // configured chunk was 6.
      //
      // So it is asked for, and without it this reports the interval and stops
      // rather than inventing the other half of the sum.
      const fit = CHUNK ? keyframeFits(kf.seconds, CHUNK) : null;
      if (fit && !fit.fits) {
        line(`    ${kf.seconds}s does not divide the configured chunk of ${CHUNK}s evenly`
          + ` (${fit.perChunk} per chunk)`);
        line(`    → either set the encoder's keyframe interval to ${fit.suggestion.keyframeSeconds}s,`);
        line(`      or set the application's chunk to ${fit.suggestion.orChunkSeconds}s in the panel.`);
        line('    The first is the encoder\'s to change, the second is the panel\'s.');
      } else if (fit) {
        line(`    ${kf.seconds}s divides the ${CHUNK}s chunk evenly (${fit.perChunk} per chunk)`);
      } else if (spread && spread.spread > 0.5) {
        line('    the configured chunk is not in the playlist — pass --chunk=<seconds>');
        line('    (from the application in WMSPanel) and this will say what to change');
      }
    } else if (p.parts) {
      line('  keyframes: no part is marked INDEPENDENT, so the interval cannot be read here');
    }

    if (p.programDateTime) {
      const behind = (Date.now() - Date.parse(p.programDateTime)) / 1000;
      line(`  the first segment in this playlist is dated ${behind.toFixed(1)}s ago`);
      line('    (a floor on how far behind live a viewer starts, not the latency itself)');
    }

    if (!p.parts) {
      line('  No parts. This is ordinary HLS, whatever is switched on elsewhere.');
      line('');
      continue;
    }

    // --- the measurement --------------------------------------------------
    const base = await get(vurl, 15_000);

    // Ask for a part the server has said does not exist yet.
    //
    // The first version computed `MEDIA-SEQUENCE + segment count` and asked
    // for part 0 of it. With parts, the last segment is already in progress —
    // its parts sit after the last EXTINF — so that number often names a part
    // that already exists, and the server answers instantly and correctly.
    // Two runs then produced opposite verdicts from the same server, which is
    // a property of the arithmetic and not of the server.
    //
    // `PRELOAD-HINT` is the server naming the next part itself. Where it is
    // absent, the count of in-progress parts gives the next index.
    const inProgress = p.partsInProgress;
    const curMsn = (p.mediaSequence ?? 0) + p.segmentDurations.length;
    const sep = vurl.includes('?') ? '&' : '?';
    const blockedUrl = p.preloadHintUri
      ? abs(vurl, p.preloadHintUri)
      : `${vurl}${sep}_HLS_msn=${curMsn}&_HLS_part=${inProgress}`;
    line(p.preloadHintUri
      ? `  asking for the part the server hinted at, which does not exist yet…`
      : `  asking for media sequence ${curMsn} part ${inProgress}, which does not exist yet…`);
    line(`    (${inProgress} part(s) already published for the segment in progress)`);
    const blocked = await get(blockedUrl, 30_000);

    const verdict = blockingVerdict({
      baseMs: base.ms,
      blockedMs: blocked.ok ? blocked.ms : null,
      partTarget: p.partTarget,
    });
    line(`  ordinary request: ${(base.ms / 1000).toFixed(2)}s`);
    line(`  blocking request: ${blocked.ok ? (blocked.ms / 1000).toFixed(2) + 's' : blocked.error}`);
    line(`  held for ${verdict.held ?? '—'}s (needs ${verdict.threshold ?? '—'}s to count)`);
    line('');
    line(`  ${verdict.working ? 'LL-HLS IS WORKING' : 'LL-HLS IS NOT WORKING ON THE WIRE'}`);
    line(`  ${verdict.why}`);
    line('');

    // The version question, reported once and not concluded.
    if (p.version !== null && p.version < 9) {
      line(`  Note: the server declares #EXT-X-VERSION:${p.version} while emitting parts.`);
      line('  Apple\'s specification puts parts at version 9. Whether a given player');
      line('  honours the declared version and ignores the parts is not decided here —');
      line('  the blocking measurement above is about the server, not about clients.');
      line('');
    }
    decided = true;
  }

  if (!decided) {
    line('Nothing could be measured: no variant carried parts.');
  }
  line(`Requests sent: ${calls}.`);
}

if (IS_MAIN) {
  main().then(writeReport)
    .catch((e) => { line(`failed: ${e?.message || e}`); writeReport(); process.exit(1); });
}
