import { distanceKm } from './referencePoints.js';
import { PROTOCOLS, playbackPath } from './protocols.js';

// Which edge a viewer gets, and what URL they are handed.
//
// Softvelum do not ship this. Their documented answer is that balancing is
// "an arbiter": something you write, which reads the Nimble API for load,
// optionally locates the viewer, and returns a URL. Every operator writes it
// again. The panel already polls the fleet, already holds the topology, and
// already knows where each box is — it is the arbiter, and it only lacked the
// last step.
//
// Everything below is a pure function of state the caller has already
// gathered. No network, no database, no clock: a decision that sends viewers
// somewhere must be reproducible and arguable, and one that reaches out
// mid-decision is neither.

// An edge is a candidate when the operator has not disabled it, the panel has
// not seen it fail, and it is actually serving the channel. The third is the
// one that matters: an edge can be up, reachable and serving nothing, and
// sending viewers to it produces a player that spins forever.
export function candidates(edges, { channel = '' } = {}) {
  return edges.filter(e => {
    if (e.enabled === false) return false;
    if (e.healthy === false) return false;
    // Having a route for the channel is what makes an edge able to serve it.
    //
    // This used to require the edge to be *already streaming* the channel, and
    // that was a deadlock of the panel's own making: an HLS re-streaming route
    // pulls nothing until a viewer asks, so an idle edge served nothing, was
    // therefore not a candidate, was therefore sent no viewers, and therefore
    // stayed idle. The first release of m5 could not hand out a single link on
    // a working network.
    //
    // What the edge is currently serving is a reading, not a gate. `undefined`
    // still means nobody looked, and an edge nobody looked at stays in.
    if (channel && e.routes && !e.routes.includes(channel)) return false;
    return true;
  });
}

// Reasons are returned, not logged. An operator asking "why did this viewer go
// to Frankfurt" deserves the actual comparison, not a shrug.
export function chooseEdge(edges, { policy = 'nearest', viewer = null, channel = '' } = {}) {
  const pool = candidates(edges, { channel });
  if (!pool.length) return { edge: null, reason: 'no-healthy-edge', considered: edges.length };

  // With one candidate no policy ran and nothing was compared. Reporting
  // "weight was used" here describes a comparison that never happened — the
  // same small dishonesty this milestone has been removing everywhere else,
  // and the one an operator with a single edge would read on every preview.
  if (pool.length === 1) return { edge: pool[0], reason: 'only-candidate', considered: 1 };

  if (policy === 'nearest') {
    // Only edges whose position is known can be ranked by distance, and a
    // viewer whose position is unknown cannot rank anything. Falling through
    // to weighted is stated, not silent: "nearest" that quietly became
    // "whichever" is how a CDN develops a favourite continent.
    const placed = pool.filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lon));
    if (!viewer || !Number.isFinite(viewer.lat) || !Number.isFinite(viewer.lon)) {
      return { ...byWeight(pool), reason: 'viewer-unlocated', fellBackFrom: 'nearest' };
    }
    if (!placed.length) {
      return { ...byWeight(pool), reason: 'edges-unlocated', fellBackFrom: 'nearest' };
    }
    const ranked = placed
      .map(e => ({ e, km: Math.round(distanceKm(viewer, e)) }))
      .sort((a, b) => a.km - b.km);
    return {
      edge: ranked[0].e, reason: 'nearest', distanceKm: ranked[0].km,
      considered: pool.length,
      runnersUp: ranked.slice(1, 3).map(r => ({ edge: r.e.name, distanceKm: r.km })),
    };
  }

  if (policy === 'least-loaded') {
    const known = pool.filter(e => Number.isFinite(e.connections));
    if (!known.length) return { ...byWeight(pool), reason: 'load-unknown', fellBackFrom: 'least-loaded' };
    const ranked = [...known].sort((a, b) => a.connections - b.connections);
    return {
      edge: ranked[0], reason: 'least-loaded', connections: ranked[0].connections,
      considered: pool.length,
      runnersUp: ranked.slice(1, 3).map(e => ({ edge: e.name, connections: e.connections })),
    };
  }

  if (policy === 'failover') {
    // The operator's own order, first healthy one wins. No cleverness: that is
    // the point of choosing it.
    return { edge: pool[0], reason: 'failover-first-healthy', considered: pool.length };
  }

  return { ...byWeight(pool), reason: 'weighted' };
}

// Deterministic rather than random: the same viewer asking twice gets the same
// edge, so a player retrying does not start a second session elsewhere. Spread
// across edges comes from the viewer key, not from a coin toss.
function byWeight(pool, key = '') {
  const total = pool.reduce((a, e) => a + Math.max(0, e.weight ?? 100), 0);
  if (total <= 0) return { edge: pool[0], considered: pool.length };
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  let point = (key ? h % total : 0);
  for (const e of pool) {
    point -= Math.max(0, e.weight ?? 100);
    if (point < 0) return { edge: e, considered: pool.length };
  }
  return { edge: pool[0], considered: pool.length };
}

const trim = s => String(s || '').replace(/^\/+|\/+$/g, '');

// The URL handed to the viewer, and — just as important — what it reveals.
//
// The panel states the exposure rather than leaving the operator to work it
// out from the string: a redirect gateway without DNS names on the edges hides
// nothing at all, and that is exactly the configuration someone would set up
// believing it does.
export function viewerUrl({ mode, domain, node, edge, channel, stream, protocol = 'hls' }) {
  const proto = PROTOCOLS[protocol] || PROTOCOLS.hls;
  const path = playbackPath(protocol, channel, stream);
  const edgeHost = edge?.publicHost || edge?.host || '';
  // A protocol that requires TLS is addressed over TLS. Building an https URL
  // against the plain port would produce a link that cannot connect, and an
  // http one for LL-HLS produces the silent fallback instead.
  const secure = proto.scheme === 'https';
  const edgePort = secure ? (edge?.httpsPort || 443) : (edge?.httpPort || 8081);
  const edgeUrl = `${proto.scheme}://${edgeHost}:${edgePort}${path}`;

  if (mode === 'direct') {
    return { url: edgeUrl, exposes: edge?.publicHost ? 'edge-name' : 'edge-address', via: 'edge' };
  }
  const front = domain ? `https://${domain}` : (node?.host ? `${proto.scheme}://${node.host}` : '');
  if (!front) return { url: edgeUrl, exposes: 'edge-address', via: 'edge', degraded: 'gateway-has-no-address' };

  if (mode === 'redirect') {
    return {
      url: `${front}${path}`,
      redirectsTo: edgeUrl,
      // The honest part. A 302 to an IP is an IP the viewer sees.
      exposes: edge?.publicHost ? 'edge-name' : 'edge-address',
      via: 'gateway-redirect',
    };
  }
  if (mode === 'proxy') {
    return { url: `${front}${path}`, exposes: 'nothing', via: 'gateway-proxy' };
  }
  return { url: edgeUrl, exposes: 'edge-address', via: 'edge' };
}

// What a gateway node needs in order to answer without asking the panel.
// Pushed, not polled: a gateway that consults the panel per viewer turns a
// panel outage into a delivery outage, which is the correlation this whole
// design has been avoiding since the discussion about self-hosting.
export function routingTable({ network, edges, channels }) {
  return {
    version: 1,
    network: network.name,
    policy: network.gateway?.policy || 'nearest',
    whenAllDown: network.gateway?.whenAllDown || 'fail',
    generatedAt: null,   // stamped by the caller, so this stays pure
    channels: channels.map(c => trim(c)),
    edges: edges.map(e => ({
      name: e.name, host: e.publicHost || e.host, port: e.httpPort || 8081,
      weight: e.weight ?? 100, lat: e.lat ?? null, lon: e.lon ?? null,
      channels: e.channels ?? null,
    })),
  };
}
