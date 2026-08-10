// Does the network do what the plan says it does?
//
// m2 could write routes and verify that WMSPanel stored them. Stored is not
// delivering: a route can be correct, present and pointing at an origin that
// has nothing on it, and the panel would have shown a green apply and a tidy
// list. The operator's real question is narrower and harder — "is this edge
// serving what I think, from where I think" — and it needs two sources that
// disagree in interesting ways: the account's routes, and what each box says
// is actually streaming.
//
// Nothing here invents a metric. It uses `/manage/live_streams_status`, which
// this panel already reads and whose `bandwidth` field is already relied on
// elsewhere, plus the routes m2 writes. Cache hit rates would be the obvious
// next thing to show and there is no confirmed endpoint for them, so they are
// absent rather than estimated.

const trim = s => String(s || '').replace(/^\/+|\/+$/g, '');

// Why a box could not be read, split by what the operator would do about it.
// One word — "unreachable" — covers three different jobs: install an agent,
// look at an agent that is already running, or look at Nimble. Lives here
// rather than in the route so it can be checked without a server.
export function probeReason(error, hadAgent) {
  const msg = String(error?.message || error || '');
  // Nimble answered, and answered with a refusal: the transport is fine and
  // sending the operator to look at the agent would waste their time.
  if (/^Nimble API HTTP/.test(msg) || /^nimble returned \d+ for /.test(msg)) return 'nimble-refused';
  return hadAgent ? 'agent-and-direct-failed' : 'no-agent-and-direct-failed';
}

// A stream index keyed by application, from a live_streams_status response.
// Shapes vary across Nimble versions, hence the alternatives — all of them
// already handled by the collector this borrows from.
export function indexStreams(payload) {
  const out = new Map();   // application -> [{ stream, bandwidth }]
  const list = Array.isArray(payload?.streams) ? payload.streams
    : Array.isArray(payload) ? payload : [];
  for (const st of list) {
    const app = trim(st.application ?? st.app ?? '');
    if (!app) continue;
    const entry = {
      stream: String(st.stream ?? st.name ?? ''),
      bandwidth: Number(st.bandwidth ?? st.bitrate ?? 0) || 0,
    };
    out.set(app, [...(out.get(app) || []), entry]);
  }
  return out;
}

const totalBw = (entries) => (entries || []).reduce((a, e) => a + (e.bandwidth || 0), 0);

// What each application is doing on each edge, and where the configuration has
// drifted from the plan.
//
// `live` maps a server's own id to the parsed live_streams_status of that box,
// or to null when it could not be reached — which is itself a finding and is
// reported as one rather than as "nothing is streaming".
export function networkState({ network, servers, existingRoutes = [], channels = [], live = {}, probe = {} }) {
  const byId = new Map(servers.map(s => [String(s._id ?? s.id), s]));
  const nodeById = new Map((network.nodes || []).map(n => [String(n.id ?? n._id), n]));
  const edges = (network.nodes || []).filter(n => n.role === 'edge' && n.enabled !== false);

  const rows = [];
  const drift = [];

  // Every route the account holds for a server in this network, so unplanned
  // ones are visible instead of merely absent from the plan.
  const inNetwork = new Set(
    (network.nodes || []).map(n => byId.get(String(n.server))?.wmspanelServerId).filter(Boolean).map(String));

  for (const edge of edges) {
    const edgeServer = byId.get(String(edge.server));
    if (!edgeServer?.wmspanelServerId) continue;
    const wsid = String(edgeServer.wmspanelServerId);

    const originNode = (edge.upstream || []).map(u => nodeById.get(String(u))).filter(Boolean)[0];
    const originServer = originNode ? byId.get(String(originNode.server)) : null;

    const edgeKey = String(edgeServer._id ?? edgeServer.id);
    const originKey = originServer ? String(originServer._id ?? originServer.id) : null;
    const edgeStreams = live[edgeKey];
    const originStreams = originKey ? live[originKey] : undefined;

    const routesHere = existingRoutes.filter(r => (r.servers || []).map(String).includes(wsid));

    for (const application of channels) {
      const app = trim(application);
      const route = routesHere.find(r => trim(r.from) === app);
      const onOrigin = originStreams ? (originStreams.get(app) || []) : null;
      const onEdge = edgeStreams ? (edgeStreams.get(app) || []) : null;

      // The verdict is about what an operator would do next, so "we could not
      // ask" is kept apart from "we asked and there is nothing".
      let verdict;
      if (!route) verdict = 'no-route';
      else if (edgeStreams === undefined || edgeStreams === null) verdict = 'edge-unreachable';
      else if (onEdge.length) verdict = 'flowing';
      else if (originStreams && onOrigin.length) verdict = 'origin-only';
      else if (originStreams && !onOrigin.length) verdict = 'nothing-upstream';
      else verdict = 'origin-unknown';

      rows.push({
        edge: edgeServer.name, origin: originServer?.name || null, application: app,
        routeId: route?.id || null, to: route?.to || null,
        edgeStreams: onEdge?.length ?? null, edgeBandwidth: onEdge ? totalBw(onEdge) : null,
        originStreams: onOrigin?.length ?? null, originBandwidth: onOrigin ? totalBw(onOrigin) : null,
        // Which path answered, and why it did not when it did not. A reading
        // whose provenance is known and unsaid asks for trust the panel has no
        // right to request.
        edgeProbe: probe[edgeKey] || null,
        originProbe: originKey ? (probe[originKey] || null) : null,
        verdict,
      });
    }

    // Routes on this edge that no channel in the plan accounts for. Not an
    // error — an operator may run routes this panel did not create — but the
    // one thing a "what is on my network" view must not quietly omit.
    for (const r of routesHere) {
      if (!channels.some(c => trim(c) === trim(r.from))) {
        drift.push({ code: 'unplanned-route', edge: edgeServer.name, from: r.from, to: r.to, routeId: r.id });
      }
    }
  }

  // Routes pointing at servers of this network that belong to no edge — for
  // instance left on a box whose role was changed to origin.
  for (const r of existingRoutes) {
    const targets = (r.servers || []).map(String).filter(s => inNetwork.has(s));
    if (!targets.length) continue;
    const servedByAnEdge = edges.some(e => {
      const s = byId.get(String(e.server));
      return s?.wmspanelServerId && targets.includes(String(s.wmspanelServerId));
    });
    if (!servedByAnEdge) {
      drift.push({ code: 'route-on-non-edge', from: r.from, to: r.to, routeId: r.id });
    }
  }

  return {
    rows, drift,
    summary: {
      flowing: rows.filter(r => r.verdict === 'flowing').length,
      broken: rows.filter(r => ['no-route', 'origin-only'].includes(r.verdict)).length,
      unknown: rows.filter(r => ['edge-unreachable', 'origin-unknown'].includes(r.verdict)).length,
    },
  };
}
