// Being the viewer, iter20 m5 correction.
//
// The panel spent three milestones inferring delivery from what an edge was
// streaming, and an HLS re-streaming route streams nothing until asked. The
// only honest test is to ask — and then to read the answer properly, which is
// where most of the distinctions below live.
import assert from 'node:assert/strict';
import { parsePlaylist, movedOn, classifyProbe, playlistPath } from '../src/services/playlistProbe.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:812
#EXTINF:4.000,
segment812.ts
#EXTINF:4.000,
segment813.ts
`;

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360
360p/playlist.m3u8
`;

console.log('\nREADING WHAT CAME BACK:');

check('the path is the one a player asks for', () => {
  assert.equal(playlistPath('test2', 'stream'), '/test2/stream/playlist.m3u8');
  assert.equal(playlistPath('/test2/', '/stream/'), '/test2/stream/playlist.m3u8');
});

check('a media playlist yields its segments and sequence', () => {
  const p = parsePlaylist(MEDIA);
  assert.equal(p.valid, true);
  assert.equal(p.kind, 'media');
  assert.equal(p.segments, 2);
  assert.equal(p.mediaSequence, 812);
  assert.equal(p.targetDuration, 4);
});

check('a master playlist is success, not an empty media playlist', () => {
  // "No segments, therefore broken" would report a working ABR ladder as dead.
  const p = parsePlaylist(MASTER);
  assert.equal(p.kind, 'master');
  assert.equal(p.variants, 2);
  assert.equal(p.segments, 0);
  assert.equal(classifyProbe({ status: 200, playlist: p }).ok, true);
});

check('an HTML error page is not a playlist', () => {
  // The failure mode of a misrouted request: 200, a body, and nothing usable.
  const p = parsePlaylist('<html><body>404 not found</body></html>');
  assert.equal(p.valid, false);
  assert.equal(classifyProbe({ status: 200, playlist: p }).code, 'not-a-playlist');
});

console.log('\nLIVE, OR MERELY VALID:');

check('a moving sequence is live', () => {
  const a = parsePlaylist(MEDIA);
  const b = parsePlaylist(MEDIA.replace('MEDIA-SEQUENCE:812', 'MEDIA-SEQUENCE:814'));
  assert.equal(movedOn(a, b), true);
  assert.equal(classifyProbe({ status: 200, playlist: b, advanced: true }).code, 'live');
});

check('a frozen playlist is served but stalled, not broken', () => {
  // A stalled edge serves a perfectly valid playlist forever. It is fine and
  // the content behind it is not — a different call from "the edge is broken",
  // and a different thing to go and look at.
  const a = parsePlaylist(MEDIA);
  assert.equal(movedOn(a, a), false);
  const v = classifyProbe({ status: 200, playlist: a, advanced: false });
  assert.equal(v.ok, true);
  assert.equal(v.code, 'stalled');
  assert.equal(v.warn, true);
});

check('one reading cannot say whether it is live, and does not claim to', () => {
  const v = classifyProbe({ status: 200, playlist: parsePlaylist(MEDIA) });
  assert.equal(v.code, 'served');
  assert.notEqual(v.code, 'live');
});

check('a playlist without a sequence number yields no verdict on movement', () => {
  const noSeq = parsePlaylist(MEDIA.replace(/#EXT-X-MEDIA-SEQUENCE:\d+\n/, ''));
  assert.equal(movedOn(noSeq, noSeq), null);
});

console.log('\nEACH FAILURE HAS ITS OWN FIX:');

check('404 is a missing route, not a dead edge', () => {
  // The edge answered. It simply has no mapping for that path — which is fixed
  // by applying the plan, not by looking at the server.
  assert.equal(classifyProbe({ status: 404 }).code, 'route-missing');
});

check('5xx points at the origin, not the edge', () => {
  // The edge is up and forwarding; whatever it forwarded to is not.
  assert.equal(classifyProbe({ status: 502 }).code, 'origin-error');
});

check('a timeout and a refusal are told apart, however node words it', () => {
  // Three real phrasings, from three places node raises them. Matching only
  // the noun "timeout" turned "The operation timed out" into "unreachable",
  // sending the operator to hunt a firewall instead of a slow origin.
  for (const e of ['The operation timed out', 'TimeoutError: signal timed out',
                   'This operation was aborted']) {
    assert.equal(classifyProbe({ error: e }).code, 'edge-timeout', e);
  }
  assert.equal(classifyProbe({ error: 'connect ECONNREFUSED 10.0.0.2:8081' }).code, 'edge-unreachable');
  assert.equal(classifyProbe({ error: 'getaddrinfo ENOTFOUND edge.example' }).code, 'edge-unreachable');
});

check('an empty media playlist is named as empty', () => {
  const empty = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n');
  assert.equal(classifyProbe({ status: 200, playlist: empty }).code, 'empty-playlist');
});

check('403 is a refusal, which is a configuration answer', () => {
  assert.equal(classifyProbe({ status: 403 }).code, 'refused');
});

console.log(failures ? `\n${failures} playlist-probe check(s) failed` : '\nall playlist-probe checks passed');
process.exit(failures ? 1 : 0);
