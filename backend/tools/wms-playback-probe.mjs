#!/usr/bin/env node
//
// Being the viewer.
//
// Two questions that configuration cannot answer:
//
//   1. **Where does the content actually live?** The panel builds
//      `/app/stream/playlist.m3u8` for HLS and `/app/stream/manifest.mpd` for
//      DASH, and the second of those has never been fetched — it comes from
//      documentation, and `protocols.js` carries a `pathUnverified` flag
//      admitting it. One request settles it.
//
//   2. **Does adding `HLS_FMP4` to an application move the playback path?**
//      The whole fleet runs plain `HLS`, which Softvelum describes as the
//      audio-optimised container; for video they recommend fMP4. Whether the
//      master playlist then lists a second variant, replaces the first, or
//      looks identical is not written down anywhere. It is visible in one
//      fetch before and one after.
//
// This tool does not read Nimble's configuration and does not ask WMSPanel
// what should be true. It asks the edge for a playlist and reads what came
// back, which is the only test of delivery that a pull-model CDN admits: an
// idle edge holds nothing until somebody asks.
//
// NO STREAM, NO EVIDENCE. An application with nothing publishing into it
// answers 404 to everything, and that 404 says nothing about paths. The run
// says so plainly instead of reporting an absence as a finding.
//
// READ-ONLY by default. The write half adds `HLS_FMP4` to one application,
// re-reads, and puts it back — and refuses to touch anything not named
// `nnm-probe`, exactly as wms-app-write-probe.mjs does.
//
// Usage:
//
//     node wms-playback-probe.mjs <base-url> <application> <stream>
//
//     node wms-playback-probe.mjs <base-url> <application> <stream> \
//          --enable-fmp4 --write \
//          --client-id=<id> --api-key=<key> --server=<wmspanel server id>
//
// base-url is the edge as a viewer reaches it, e.g. http://1.2.3.4:8081
//
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => (argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');

const WRITE = flag('write');
const WAIT_S = Number(opt('wait')) > 0 ? Number(opt('wait')) : 10;
const ENABLE_FMP4 = flag('enable-fmp4');
const CLIENT_ID = opt('client-id');
const API_KEY = opt('api-key');
const SERVER_ID = opt('server');
const WMS_BASE = (process.env.WMS_BASE || 'https://api.wmspanel.com/v1').replace(/\/+$/, '');
const [BASE, APPLICATION, STREAM] = argv.filter(a => !a.startsWith('--'));
const TIMEOUT_MS = 12000;

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, `wms-playback-${new Date().toISOString().slice(0, 10)}.txt`);
const IS_MAIN = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

const out = [];
const line = (s = '') => { process.stdout.write(s + '\n'); out.push(s); };
function writeReport() {
  try { writeFileSync(REPORT, out.join('\n') + '\n'); process.stderr.write(`\nwritten: ${REPORT}\n`); }
  catch (e) { process.stderr.write(`\ncould not write ${REPORT}: ${e?.message || e}\n`); }
}

export const GUARD_NAME = 'nnm-probe';

// ---------------------------------------------------------------------------
// A copy of backend/src/services/playlistProbe.js's reader.
//
// This file is standalone and cannot import it. backend/tests/
// playback-probe.test.mjs runs both over the same fixtures and fails when they
// disagree — the same treatment the LL-HLS constants get.
// ---------------------------------------------------------------------------
export function parsePlaylist(text) {
  const body = String(text || '');
  if (!/^\s*#EXTM3U/.test(body)) return { valid: false, reason: 'not-a-playlist', bytes: body.length };
  const lines = body.split(/\r?\n/);
  const variants = lines.filter(l => l.startsWith('#EXT-X-STREAM-INF')).length;
  const segments = lines.filter(l => l.startsWith('#EXTINF')).length;
  const seq = Number((body.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1]);
  const target = Number((body.match(/#EXT-X-TARGETDURATION:(\d+)/) || [])[1]);
  const uris = lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const map = (body.match(/#EXT-X-MAP:URI="([^"]+)"/) || [])[1] || null;
  const exts = [...new Set(uris.map(u => (u.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1]).filter(Boolean))];
  let container = null;
  if (map || exts.some(e => ['fmp4', 'm4s', 'mp4'].includes(e))) container = 'fmp4';
  else if (exts.includes('ts')) container = 'mpegts';
  const parts = lines.filter(l => l.startsWith('#EXT-X-PART:')).length;
  const partTarget = Number((body.match(/#EXT-X-PART-INF:PART-TARGET=([\d.]+)/) || [])[1]);
  const holdBack = Number((body.match(/PART-HOLD-BACK=([\d.]+)/) || [])[1]);
  return {
    valid: true,
    kind: variants > 0 ? 'master' : 'media',
    variants, segments,
    mediaSequence: Number.isFinite(seq) ? seq : null,
    targetDuration: Number.isFinite(target) ? target : null,
    ended: /#EXT-X-ENDLIST/.test(body),
    bytes: body.length,
    uris,
    initSegment: map,
    container,
    segmentExtensions: exts,
    lowLatency: {
      parts,
      partTarget: Number.isFinite(partTarget) ? partTarget : null,
      holdBack: Number.isFinite(holdBack) ? holdBack : null,
      canBlockReload: /CAN-BLOCK-RELOAD=YES/.test(body),
      preloadHint: /#EXT-X-PRELOAD-HINT/.test(body),
      confirmed: parts > 0 && Number.isFinite(partTarget) && /CAN-BLOCK-RELOAD=YES/.test(body),
    },
  };
}

if (IS_MAIN && (!BASE || !APPLICATION || !STREAM)) {
  line('usage: node wms-playback-probe.mjs <base-url> <application> <stream> [options]');
  line('');
  line('  base-url     the edge as a viewer reaches it, e.g. http://1.2.3.4:8081');
  line('');
  line('  --enable-fmp4 --write   add HLS_FMP4, re-read, put it back');
  line(`                          only for an application named \`${GUARD_NAME}\``);
  line('  --client-id=… --api-key=… --server=…   needed only for the write half');
  line('  --wait=<seconds>        window to restart the input stream in (default 10)');
  line('');
  line('  WMS_BASE=https://api.wmspanel.ru/v1   to use the mirror');
  line('');
  line('Read-only without --write. Nothing is deleted, ever.');
  process.exit(1);
}

let calls = 0;
async function get(url) {
  calls++;
  const started = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
    const text = await r.text();
    return { status: r.status, ms: Date.now() - started, type: r.headers.get('content-type') || '', text, url };
  } catch (e) {
    return { status: null, ms: Date.now() - started, error: String(e?.message || e).slice(0, 200), url };
  }
}

const root = () => `${BASE.replace(/\/+$/, '')}/${APPLICATION.replace(/^\/+|\/+$/g, '')}/${STREAM.replace(/^\/+|\/+$/g, '')}`;

// Resolve a playlist URI against the playlist that named it, query string and
// all. Nimble hangs `?nimblesessionid=` off variant URIs and a fetch without
// it gets a different session.
const resolve = (from, uri) => new URL(uri, from).toString();

// ---------------------------------------------------------------------------
// One census of what this application serves right now.
//
// Only two paths are asked for blind: the HLS master and the DASH manifest,
// both of which the panel already builds. Everything else is *followed* from
// what the master said. Guessing spellings is how a week went missing here
// once already.
// ---------------------------------------------------------------------------
export async function census(fetchFn = get) {
  const found = [];
  const master = await fetchFn(`${root()}/playlist.m3u8`);
  found.push({ what: 'HLS master', path: '/playlist.m3u8', res: master });

  const parsedMaster = master.status === 200 ? parsePlaylist(master.text) : null;
  if (parsedMaster?.valid) {
    for (const uri of parsedMaster.uris) {
      const url = resolve(master.url, uri);
      const child = await fetchFn(url);
      found.push({ what: 'variant', path: uri, res: child, parsed: child.status === 200 ? parsePlaylist(child.text) : null });
    }
  }

  const dash = await fetchFn(`${root()}/manifest.mpd`);
  found.push({ what: 'DASH manifest', path: '/manifest.mpd', res: dash });

  return { master, parsedMaster, found };
}

function describe(entry) {
  const { res, parsed } = entry;
  if (res.status !== 200) return `${res.status ?? 'ERR'}${res.error ? ' ' + res.error : ''}`;
  if (entry.what === 'DASH manifest') {
    const ok = /<MPD[\s>]/.test(res.text);
    return ok ? `200 MPD, ${res.text.length} bytes` : `200 but not an MPD (${res.type})`;
  }
  const p = parsed || parsePlaylist(res.text);
  if (!p.valid) return `200 but not a playlist (${p.reason})`;
  if (p.kind === 'master') return `200 master, ${p.variants} variant(s)`;
  const ll = p.lowLatency.confirmed
    ? `LL-HLS parts=${p.lowLatency.parts} target=${p.lowLatency.partTarget}s hold-back=${p.lowLatency.holdBack}s`
    : 'no parts (ordinary HLS)';
  return `200 media, seq=${p.mediaSequence ?? '—'}, ${p.segments} segment(s), container=${p.container || 'unknown'}, ${ll}`;
}

// Parameters Nimble mints per request. They belong in a fetch — dropping
// `nimblesessionid` gets a different session — and they must not appear in a
// comparison, where they make every run look like a path change.
//
// The first version of this compared raw URIs and reported
// `chunks.m3u8?nimblesessionid=1` → `chunks.m3u8?nimblesessionid=3` as paths
// disappearing and appearing, and printed the alarming verdict: that adding
// the container had moved existing viewers. Nothing had moved. Fetching and
// comparing are two jobs and the URI is not the right key for both.
export const VOLATILE_PARAMS = ['nimblesessionid'];

export function stablePath(uri) {
  const [p, q] = String(uri).split('?');
  if (!q) return p;
  const kept = q.split('&').filter(kv => !VOLATILE_PARAMS.includes(kv.split('=')[0]));
  return kept.length ? `${p}?${kept.join('&')}` : p;
}

// Did the stream restart between two censuses?
//
// This is what decided nothing in the first two live runs: "no observable
// change" and "the setting never took effect" looked identical, and the report
// could only list both. The media sequence tells them apart — a stream that
// kept running has a higher one, a stream that was restarted starts over.
//
// `null` where there is nothing to compare, because "we could not tell" is a
// third answer and must not collapse into either of the other two.
export function restarted(before, after) {
  const b = before?.mediaSequence, a = after?.mediaSequence;
  if (!Number.isFinite(b) || !Number.isFinite(a)) return null;
  if (a < b) return true;
  if (a > b) return false;
  // Equal means the playlist has not advanced at all between two reads, which
  // is a stalled stream rather than an answer about restarting.
  return null;
}

// The set of paths a viewer can reach. Compared before and after the container
// change — but not as one set.
//
// Two kinds of path live in that list and they answer different questions:
//
//   - **entry points**: `/playlist.m3u8` and `/manifest.mpd`. These are what
//     `channelLinks` builds and what an operator hands out. If one of these
//     moves, every published link is wrong.
//   - **variants**: whatever the master names. A player discovers these on
//     each session and nobody bookmarks them, so one changing is invisible to
//     anything the panel publishes.
//
// The first version compared them together, so `chunks.m3u8` becoming
// `video.m3u8` printed "existing viewers reach something different — not safe
// without changing the links", when the link had not moved at all. Third time
// in this tool that the comparison key was wrong for the question being asked.
export const ENTRY_PATHS = ['/playlist.m3u8', '/manifest.mpd'];

const setOf = (c, keep) =>
  [...new Set(c.found.filter(e => e.res.status === 200)
    .map(e => stablePath(e.path))
    .filter(p => keep(ENTRY_PATHS.includes(p))))].sort();

export const entryPathsOf = (c) => setOf(c, isEntry => isEntry);
export const variantPathsOf = (c) => setOf(c, isEntry => !isEntry);
export const pathsOf = (c) =>
  [...new Set(c.found.filter(e => e.res.status === 200).map(e => stablePath(e.path)))].sort();

function report(c, heading) {
  line(`=== ${heading}`);
  line('');
  for (const e of c.found) line(`  ${e.what.padEnd(14)} ${e.path.padEnd(38)} ${describe(e)}`);
  line('');
}

// ---------------------------------------------------------------------------
const auth = () => `client_id=${encodeURIComponent(CLIENT_ID)}&api_key=${encodeURIComponent(API_KEY)}`;
async function wms(p, method = 'GET', body) {
  calls++;
  const url = `${WMS_BASE}${p}${p.includes('?') ? '&' : '?'}${auth()}`;
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, ok: r.status === 200 && (!json || json.status === 'Ok') };
}

async function main() {
  line(`Edge: ${BASE}`);
  line(`Application/stream: ${APPLICATION}/${STREAM}`);
  line(`Date: ${new Date().toISOString()}`);
  line(WRITE ? 'Mode: WRITE (adds HLS_FMP4, then restores)' : 'Mode: read-only');
  line('');

  const before = await census();
  report(before, 'What the edge serves now');

  if (before.master.status !== 200) {
    line('The HLS master did not answer 200.');
    line('');
    line('If nothing is publishing into this application, that is what a 404');
    line('looks like, and it is not evidence about paths or containers — an');
    line('edge in a pull model holds nothing until a stream exists to hold.');
    line('Start a stream into it and run this again.');
    line('');
    line(`Requests sent: ${calls}.`);
    return;
  }

  const dash = before.found.find(e => e.what === 'DASH manifest');
  line(dash.res.status === 200
    ? '`manifest.mpd` answered. The DASH path in protocols.js is confirmed; the'
    : '`manifest.mpd` did not answer. Either DASH is not in this application\'s');
  line(dash.res.status === 200
    ? 'pathUnverified flag on it can go.'
    : 'protocols, or the documented path is wrong — check protocols before concluding.');
  line('');

  if (!ENABLE_FMP4 || !WRITE) {
    line('Read-only run. Add --enable-fmp4 --write with WMSPanel credentials to');
    line('find out whether adding the fMP4 container moves any of this.');
    line(`Requests sent: ${calls}.`);
    return;
  }

  // --- the write half ------------------------------------------------------
  if (!CLIENT_ID || !API_KEY || !SERVER_ID) {
    line('The write half needs --client-id, --api-key and --server.');
    throw new Error('missing WMSPanel credentials');
  }

  const list = await wms(`/server/${encodeURIComponent(SERVER_ID)}/live/app`);
  const apps = list.json?.applications || [];
  const app = apps.find(a => a.application === APPLICATION);
  if (!app) {
    line(`No application named \`${APPLICATION}\` on that server.`);
    throw new Error('application not found');
  }
  if (app.application !== GUARD_NAME) {
    line(`Refusing to change \`${app.application}\`.`);
    line(`This tool writes only to \`${GUARD_NAME}\`. Nothing was sent.`);
    throw new Error('guard');
  }

  let containerReplaced = [];
  const original = Array.isArray(app.protocols) ? [...app.protocols] : [];
  line(`Protocols before: ${original.join(', ') || 'none'}`);
  if (original.includes('HLS_FMP4')) {
    line('HLS_FMP4 is already set — there is nothing to compare against.');
    throw new Error('already fmp4');
  }

  // Adding, not replacing. A replacement would answer a different question and
  // would take the existing container away from anything watching.
  const next = [...original, 'HLS_FMP4'];
  const put = await wms(`/server/${encodeURIComponent(SERVER_ID)}/live/app/${encodeURIComponent(app.id)}`,
    'PUT', { protocols: next });
  line(`PUT protocols ${JSON.stringify(next)} → ${put.ok ? 'accepted' : 'refused'}`);
  if (!put.ok) {
    line(`  ${String(put.json?.description || put.text).slice(0, 200)}`);
    throw new Error('the container change was refused');
  }
  // Accepted is not applied. Read it back before drawing anything from the
  // fetches that follow.
  //
  // And read *all* of it. The first version checked only that HLS_FMP4 had
  // arrived, and passed a run in which the server had silently dropped plain
  // HLS: sent [HLS, DASH, SLDP, HLS_FMP4], got back [HLS_FMP4, DASH, SLDP].
  // A write that removes something is not the write that was requested, and a
  // check that asks only about the field it wanted cannot see it.
  const back = await wms(`/server/${encodeURIComponent(SERVER_ID)}/live/app/${encodeURIComponent(app.id)}`);
  const nowProtocols = back.json?.application?.protocols || [];
  line(`Read back: ${nowProtocols.join(', ') || 'none'}`);

  const dropped = next.filter(p => !nowProtocols.includes(p));
  const uninvited = nowProtocols.filter(p => !next.includes(p));
  if (dropped.length || uninvited.length) {
    line('');
    line('  !!! THE SERVER DID NOT STORE WHAT WAS SENT');
    if (dropped.length) line(`      dropped:  ${dropped.join(', ')}`);
    if (uninvited.length) line(`      appeared: ${uninvited.join(', ')}`);
    line('');
    line('      This is not "adding a container". Whatever was dropped is no');
    line('      longer served, and on a live application that is viewers losing');
    line('      what they were watching — silently, since the API said Ok.');
    line('');
  }
  if (!nowProtocols.includes('HLS_FMP4')) {
    line('HLS_FMP4 is not in the application after the write. Nothing below would');
    line('be evidence about containers.');
    throw new Error('the container change did not stick');
  }
  containerReplaced = dropped;

  // The vendor is explicit that the input stream must be restarted before
  // Nimble produces the new output, and a container change is in the same
  // family as enabling LL-HLS. A running stream keeps being packaged the way
  // it was when it started, so a fetch a few seconds after the write measures
  // the old stream and says nothing about the new setting.
  //
  // The first run of this tool waited ten seconds, saw no change, and had no
  // way to tell "the container does not move the path" from "the stream was
  // never restarted". The window is now long enough to restart in, and the
  // instruction is printed rather than assumed.
  line('');
  line('  ***  RESTART THE INPUT STREAM INTO THIS APPLICATION NOW  ***');
  line('');
  line('  Nimble keeps packaging a running stream the way it was configured when');
  line('  it started. Without a restart the fetch below reads the old stream, and');
  line('  "nothing changed" would mean nothing.');
  line('');
  line(`  Waiting ${WAIT_S}s. Use --wait=<seconds> for a longer window.`);
  await new Promise(r => setTimeout(r, WAIT_S * 1000));
  line('');

  const after = await census();
  report(after, 'What the edge serves with HLS_FMP4 added');

  const shapes = (c) => c.found.filter(e => e.parsed?.container)
    .map(e => `${stablePath(e.path)}=${e.parsed.container}`).sort().join(' ');
  const beforeShapes = () => shapes(before);
  const afterShapes = () => shapes(after);

  const ea = entryPathsOf(before), eb = entryPathsOf(after);
  const va = variantPathsOf(before), vb = variantPathsOf(after);
  const entryMoved = ea.join(' ') !== eb.join(' ');
  const variantMoved = va.join(' ') !== vb.join(' ');
  const a = pathsOf(before), b = pathsOf(after);
  const added = b.filter(x => !a.includes(x));
  const gone = a.filter(x => !b.includes(x));

  line('=== Did the path move');
  line('');
  line(`  entry points  before: ${ea.join(' ') || 'none'}`);
  line(`                after:  ${eb.join(' ') || 'none'}`);
  line(`                ${entryMoved ? 'CHANGED' : 'unchanged — every published link still resolves'}`);
  line('');
  line(`  variants      before: ${va.join(' ') || 'none'}`);
  line(`                after:  ${vb.join(' ') || 'none'}`);
  line(`                ${variantMoved ? 'changed — players discover these each session' : 'unchanged'}`);
  line('');
  const containerChanged = beforeShapes() !== afterShapes();
  const media = (c) => c.found.find(e => e.parsed?.kind === 'media')?.parsed || null;
  const didRestart = restarted(media(before), media(after));
  line(`  input stream restarted: ${didRestart === null ? 'could not tell from the media sequence' : didRestart ? 'YES' : 'NO — it kept running'}`);
  line('');

  if (!added.length && !gone.length && !containerChanged && didRestart === false) {
    line('  Nothing moved, no container changed, AND THE STREAM WAS NOT RESTARTED.');
    line('  The media sequence went up, so this is the same run of the same stream,');
    line('  packaged the way it was when it started. The question is not answered —');
    line('  re-run and restart the publisher inside the window.');
  } else if (!added.length && !gone.length && !containerChanged && didRestart === true) {
    line('  Nothing moved and no container changed, across a confirmed restart.');
    line('  The container is chosen inside the same URLs: adding fMP4 is invisible');
    line('  to anything the panel builds, and the link builder needs no change.');
  } else if (!added.length && !gone.length && !containerChanged) {
    // didRestart === null. Not knowing is its own answer and must not be
    // rounded to the convenient one — an earlier version of this branch
    // announced "across a restart" on exactly this case.
    line('  Nothing moved and no container changed, and whether the stream');
    line('  restarted could not be read from the media sequence. Not settled:');
    line('  a stalled or unreadable playlist tells us nothing about containers.');
  } else if (!added.length && !gone.length) {
    line('  Same paths, different container. Adding fMP4 changes what is served');
    line('  inside the URLs the panel already builds — safe on a live application,');
    line('  and nothing in the link builder has to change.');
  } else if (added.length && !gone.length) {
    line('  New paths appeared and none disappeared: both containers are served');
    line('  side by side. The panel must decide which one a channel link points');
    line('  at, and existing viewers keep working.');
  } else if (entryMoved) {
    line('  AN ENTRY POINT MOVED. Every link the panel has handed out for this');
    line('  channel now points at something else, and they must be reissued at the');
    line('  same moment as the change.');
  } else if (variantMoved) {
    line('  The entry points held; the variant behind them changed.');
    line('');
    line('  Nothing the panel publishes has to change — a player fetches the');
    line('  master and follows it, so it finds the new variant by itself on its');
    line('  next session. What breaks is a session already in flight, holding the');
    line('  old variant URL.');
    line('');
    line('  That is not an extra cost here: the switch only takes effect after the');
    line('  input stream is restarted, and a restart ends every session anyway.');
    line('  So this is an operation with an interruption, not a link migration.');
  } else {
    line('  Paths held and the container changed in place.');
  }

  const beforeContainers = before.found.filter(e => e.parsed?.container).map(e => `${stablePath(e.path)}=${e.parsed.container}`);
  const afterContainers = after.found.filter(e => e.parsed?.container).map(e => `${stablePath(e.path)}=${e.parsed.container}`);
  line('');
  line(`  containers before: ${beforeContainers.join(' ') || 'none read'}`);
  line(`  containers after:  ${afterContainers.join(' ') || 'none read'}`);
  line('');

  if (containerReplaced.length) {
    line('');
    line(`  AND: the server dropped ${containerReplaced.join(', ')} when HLS_FMP4 went in.`);
    line('  Whatever the paths do, this is a replacement and not an addition.');
  }

  const restore = await wms(`/server/${encodeURIComponent(SERVER_ID)}/live/app/${encodeURIComponent(app.id)}`,
    'PUT', { protocols: original });
  line(`Restore protocols ${JSON.stringify(original)} → ${restore.ok ? 'accepted' : 'REFUSED'}`);
  if (!restore.ok) line(`  ${String(restore.json?.description || restore.text).slice(0, 200)}`);
  if (restore.ok && didRestart === true) {
    line('');
    line('  The settings are back. THE OUTPUT IS NOT: the stream is still running');
    line('  under the configuration it was restarted with, and will keep serving');
    line(`  ${afterShapes() || 'the new container'} until it is restarted again.`);
    line('  Restart the publisher once more to finish putting this back.');
  }
  line('');
  line(`Requests sent: ${calls}.`);
}

if (IS_MAIN) {
  main().then(writeReport)
    .catch((e) => { line(`failed: ${e?.message || e}`); writeReport(); process.exit(1); });
}
