// The playback path for each packaging, and what a server needs before it can
// actually serve it.
//
// Kept apart from the link builder because these are two different questions.
// "What is the URL for DASH" is a fact about Nimble. "Can this edge serve
// LL-HLS" is a fact about the edge, and the answer is usually no — which is
// the part that must not be silently skipped.

const trim = s => String(s || '').replace(/^\/+|\/+$/g, '');

export const PROTOCOLS = {
  // Confirmed by the fleet's own log: `add HLS chunk` and `add_chunk key=
  // '/…/l_….ts'` on an incoming SRT stream, with no configuration for it
  // anywhere in nimble.conf. This is what the panel has been probing all
  // along.
  hls: {
    id: 'hls',
    file: 'playlist.m3u8',
    scheme: 'http',
    // Every segment is a plain cacheable file, which is the whole reason the
    // edge-and-cache topology works at all.
    cacheable: true,
    requires: [],
  },

  // Also confirmed by the same log, on the same stream, at the same moment:
  // `add_dash_segment key='/…/v_….m4s'`. Nimble emits both containers from one
  // input, so offering DASH costs nothing on the server — it is a different
  // URL for content that already exists.
  dash: {
    id: 'dash',
    file: 'manifest.mpd',
    scheme: 'http',
    cacheable: true,
    // MEASURED 2026-08-17: `GET /nnm-probe/feed1/manifest.mpd` on NimbleRU-6
    // returned 200 with a 1786-byte MPD, on an application whose protocols
    // were HLS, DASH, SLDP. The `pathUnverified` flag this carried since it
    // was written is gone, and it was removed by a fetch rather than by
    // somebody deciding the documentation was probably right.
    requires: [],
  },

  // Not a URL problem. Softvelum: "LL HLS uses HTTP/2 via SSL as a transport
  // protocol… If a client tries to access LL-HLS stream via HTTP/1.1, or if
  // HTTP/2 is not properly set up, then the player will fall back to legacy
  // HLS and will not use any advantages of LL-HLS."
  //
  // A fallback is the dangerous case: it plays. The operator sees video, calls
  // it low latency, and is watching ordinary HLS with a 6-second segment
  // behind it. So this is gated on the edge having TLS, and the gate refuses
  // rather than warns.
  llhls: {
    id: 'llhls',
    file: 'playlist.m3u8',
    scheme: 'https',
    cacheable: true,
    requires: ['tls', 'http2'],
    // Enabled per application in Nimble's live streams settings, which is why
    // it can be a per-channel choice at all rather than a whole-server one.
    serverSetting: 'per-application',
  },
};

export const playbackPath = (protocol, application, stream) =>
  `/${trim(application)}/${trim(stream)}/${(PROTOCOLS[protocol] || PROTOCOLS.hls).file}`;

// Whether an edge can actually serve this, and if not, precisely what is
// missing. Returned rather than thrown: the operator is choosing, not failing.
export function protocolReadiness(protocol, edge) {
  const p = PROTOCOLS[protocol] || PROTOCOLS.hls;
  if (!p.requires.length) return { ok: true, missing: [] };

  const missing = [];
  // From a handshake, not from a field somebody filled in. The first version
  // of this read `edge.httpsPort` and `edge.http2Confirmed`, neither of which
  // existed anywhere — so LL-HLS was permanently unavailable and looked like a
  // working option.
  //
  // `notChecked` is deliberately its own answer. "We have not asked this edge"
  // is not "this edge cannot", and only one of the two is fixed by clicking
  // check.
  if (!edge?.tls?.checkedAt) return { ok: false, missing: ['not-checked'], notChecked: true };
  if (p.requires.includes('tls') && !edge.tls.tls) missing.push('tls');
  if (p.requires.includes('http2') && !edge.tls.http2) missing.push('http2');
  // A certificate a browser will refuse is a delivery failure even though the
  // handshake we made succeeded — we pass `rejectUnauthorized: false`, a
  // player does not.
  if (p.requires.includes('tls') && edge.tls.tls && !edge.tls.certTrusted) missing.push('cert');

  return { ok: missing.length === 0, missing };
}
