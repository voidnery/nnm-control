// Doing what the player does.
//
// An HLS re-streaming route is a request mapping, not a running transfer. Until
// somebody asks the edge for a playlist it pulls nothing, holds nothing and
// reports nothing — so reading its live streams and concluding "not reaching
// viewers" describes a healthy idle edge as a fault, and refusing to send
// viewers to it because it has none is a deadlock the panel built for itself.
//
// The only honest test of delivery in a pull model is to be the viewer: fetch
// the playlist and read it. That also warms the cache, so the check is not
// merely non-destructive, it is useful.
//
// Everything here is a pure function of a response. The fetching lives in the
// route; the judgement lives here, where it can be argued with offline.

export const playlistPath = (application, stream) =>
  `/${String(application || '').replace(/^\/+|\/+$/g, '')}/${String(stream || '').replace(/^\/+|\/+$/g, '')}/playlist.m3u8`;

// A playlist is either a master (a list of variants) or a media playlist (a
// list of segments). Both are success; only one of them has segments, and
// concluding "no segments, therefore broken" about a master would report a
// working ABR ladder as dead.
export function parsePlaylist(text) {
  const body = String(text || '');
  if (!/^\s*#EXTM3U/.test(body)) {
    return { valid: false, reason: 'not-a-playlist', bytes: body.length };
  }
  const lines = body.split(/\r?\n/);
  const variants = lines.filter(l => l.startsWith('#EXT-X-STREAM-INF')).length;
  const segments = lines.filter(l => l.startsWith('#EXTINF')).length;
  const seq = Number((body.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1]);
  const target = Number((body.match(/#EXT-X-TARGETDURATION:(\d+)/) || [])[1]);
  const ended = /#EXT-X-ENDLIST/.test(body);

  return {
    valid: true,
    kind: variants > 0 ? 'master' : 'media',
    variants, segments,
    mediaSequence: Number.isFinite(seq) ? seq : null,
    targetDuration: Number.isFinite(target) ? target : null,
    ended,
    bytes: body.length,
    ...readShape(lines, body),
  };
}

// What the playlist says about container and low latency.
//
// Added because the question "does adding HLS_FMP4 change the playback path"
// cannot be answered from configuration — the panel has to be the viewer and
// look. The same reading also tells LL-HLS apart from a silent fallback to
// ordinary HLS, which looks identical from the server side.
//
// Kept as a separate function so the standalone probe tool can carry a copy
// and `backend/tests/playback-probe.test.mjs` can hold the two to the same
// answers on the same fixtures.
export function readShape(lines, body) {
  // Every URI line: not a comment, not blank. Query strings stay — Nimble
  // hangs `?nimblesessionid=` off them and dropping it produces a URL that
  // does not work.
  const uris = lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  // fMP4 announces its initialisation segment. MPEG-TS never does, so this is
  // the one unambiguous container signal in the text.
  const map = (body.match(/#EXT-X-MAP:URI="([^"]+)"/) || [])[1] || null;
  const exts = [...new Set(uris.map(u => (u.split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1]).filter(Boolean))];

  let container = null;
  if (map || exts.some(e => ['fmp4', 'm4s', 'mp4'].includes(e))) container = 'fmp4';
  else if (exts.includes('ts')) container = 'mpegts';

  const parts = lines.filter(l => l.startsWith('#EXT-X-PART:')).length;
  const partTarget = Number((body.match(/#EXT-X-PART-INF:PART-TARGET=([\d.]+)/) || [])[1]);
  const holdBack = Number((body.match(/PART-HOLD-BACK=([\d.]+)/) || [])[1]);

  return {
    uris,
    initSegment: map,
    container,
    segmentExtensions: exts,
    // Three independent marks of a real LL-HLS playlist. A player falling back
    // to ordinary HLS produces a playlist with none of them, and the fallback
    // is silent — so their absence is the only way to catch it.
    lowLatency: {
      parts,
      partTarget: Number.isFinite(partTarget) ? partTarget : null,
      holdBack: Number.isFinite(holdBack) ? holdBack : null,
      canBlockReload: /CAN-BLOCK-RELOAD=YES/.test(body),
      preloadHint: /#EXT-X-PRELOAD-HINT/.test(body),
      // All of it, not any of it: a playlist can carry EXT-X-SERVER-CONTROL
      // without ever emitting a part.
      confirmed: parts > 0 && Number.isFinite(partTarget) && /CAN-BLOCK-RELOAD=YES/.test(body),
    },
  };
}

// Two readings of the same playlist, seconds apart, answer the question a
// single reading cannot: is this live, or a frozen list of the same segments?
// A stalled edge serves a perfectly valid playlist forever.
export function movedOn(before, after) {
  if (!before?.valid || !after?.valid) return null;
  if (before.mediaSequence == null || after.mediaSequence == null) return null;
  return after.mediaSequence > before.mediaSequence;
}

// What the operator should do next, which is the only reason to classify at
// all. Each of these has a different fix and they used to share one word.
export function classifyProbe({ error, status, playlist, advanced }) {
  if (error) {
    // Node words a timeout several ways depending on where it came from —
    // "timed out", "TimeoutError", "aborted due to timeout" — and matching
    // only the noun turns a timeout into "unreachable", which sends the
    // operator to look for a firewall instead of a slow origin.
    const timedOut = /timed?\s*out|timeout|abort/i.test(String(error));
    return { ok: false, code: timedOut ? 'edge-timeout' : 'edge-unreachable', detail: String(error) };
  }
  if (status === 404) return { ok: false, code: 'route-missing' };
  if (status === 403) return { ok: false, code: 'refused' };
  if (status >= 500) return { ok: false, code: 'origin-error', detail: `HTTP ${status}` };
  if (status !== 200) return { ok: false, code: 'unexpected-status', detail: `HTTP ${status}` };
  if (!playlist?.valid) return { ok: false, code: 'not-a-playlist' };
  if (playlist.kind === 'media' && playlist.segments === 0) {
    return { ok: false, code: 'empty-playlist' };
  }
  // Served, valid, and not moving. The edge is fine and the content behind it
  // is not — which is a different call to make than "the edge is broken".
  if (advanced === false) return { ok: true, code: 'stalled', warn: true };
  return { ok: true, code: advanced === true ? 'live' : 'served' };
}
