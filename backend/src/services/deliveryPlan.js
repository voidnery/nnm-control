// From "this box is an edge of that origin" to the re-streaming routes that
// actually make it one.
//
// Nimble has no concept of a delivery network. An edge becomes an edge because
// a route on it points at an origin, and until now the only record of that
// intent was in whoever typed it. m1 wrote the intent down; this turns the
// intent into the concrete objects and — more importantly — into the list of
// reasons it might not do what the operator expects.
//
// Nothing here calls WMSPanel. The plan is computed from the network, the
// fleet and the account objects already fetched, so it can be shown, argued
// with and tested without touching a server.

// Nimble's documented default for HTTP-based playback. A server whose httpPort
// the operator has not set is not an error — the panel says which number it
// assumed and where that number came from.
export const NIMBLE_DEFAULT_HTTP_PORT = 8081;

const trimSlashes = s => String(s || '').replace(/^\/+|\/+$/g, '');

// `from` is a domain and a path. An empty domain means "any address this box
// answers on", which is what an edge wants: viewers reach it by IP, by name,
// through whatever DNS the operator later points at it.
export const routeFrom = (application) => `/${trimSlashes(application)}/`;

// NOT a URL. WMSPanel refused `http://79.98.187.66:8081/test1/` with
//
//   {"status":"Error","message":"Target Domain and Port must be specified
//    (e.g 127.0.0.1:8080)"}
//
// — the scheme hid both from its parser. The target is host:port followed by
// the path, which also matches how the vendor's own UI splits the field into
// "Domain to" and "Path to". The `file:///` form in the API reference is the
// VOD special case, and reading the reference alone is what produced the
// wrong shape here: the only populated examples it shows are for serving
// files off a disk.
//
// The scheme being absent also means this cannot express an origin reached
// over HTTPS. The reference documents an SSL option in the UI but no field
// for it here, and this account has no route to learn from, so it is left
// unsupported rather than guessed at.
export const routeTo = (originHost, port, application) =>
  `${originHost}:${port}/${trimSlashes(application)}/`;

// Which address of the origin an edge should pull from. A WMSPanel server may
// answer on several (`custom_ips`), and the panel must not silently pick one:
// it takes the operator's explicit choice, falls back to the host we manage it
// by, and reports which was used.
export function originAddress(server, preferred = '') {
  if (preferred) return { host: preferred, source: 'explicit' };
  return { host: server.host, source: 'management-host' };
}

export function originHttpPort(server) {
  const p = Number(server.httpPort || 0);
  return p > 0
    ? { port: p, source: 'configured' }
    : { port: NIMBLE_DEFAULT_HTTP_PORT, source: 'nimble-default' };
}

// Every reason a planned route may not behave as read. Severity decides what
// the UI does with it: `block` refuses apply, `warn` requires the operator to
// look and confirm, `note` is context.
//
// The one that matters most is `http-origin-disables-cache`. Softvelum
// document it plainly — caching for HLS re-streaming is unavailable while HTTP
// Origin mode is on — and this fleet already runs HTTP Origin on three servers
// for the `blastdotakk` application. Turn one of those into a caching edge and
// it will fetch every chunk from the origin for every viewer: it works, it
// reports nothing, and it multiplies origin traffic by the audience. That is
// exactly the failure a panel exists to prevent.
export function planRoutes({ network, servers, originApps = [], existingRoutes = [], channels = [] }) {
  const byId = new Map(servers.map(s => [String(s._id ?? s.id), s]));
  const nodeById = new Map((network.nodes || []).map(n => [String(n.id ?? n._id), n]));
  const planned = [];
  const problems = [];

  const add = (code, severity, detail) => problems.push({ code, severity, ...detail });

  // Which applications are in HTTP Origin mode on which WMSPanel server.
  const originAppServers = new Map();   // application -> Set(wmspanelServerId)
  for (const oa of originApps) {
    const set = originAppServers.get(oa.application) || new Set();
    for (const sid of oa.server_ids || []) set.add(String(sid));
    originAppServers.set(oa.application, set);
  }

  const edges = (network.nodes || []).filter(n => n.role === 'edge' && n.enabled !== false);
  if (!edges.length) add('no-edges', 'note', {});
  if (!channels.length) add('no-channels', 'note', {});

  for (const edge of edges) {
    const edgeServer = byId.get(String(edge.server));
    if (!edgeServer) { add('edge-server-missing', 'block', { node: String(edge.id ?? edge._id) }); continue; }
    if (!edgeServer.wmspanelServerId) {
      add('edge-not-mapped', 'block', { node: String(edge.id ?? edge._id), server: edgeServer.name });
      continue;
    }

    const ups = (edge.upstream || []).map(u => nodeById.get(String(u))).filter(Boolean);
    if (!ups.length) { add('edge-without-upstream', 'block', { server: edgeServer.name }); continue; }
    // One upstream per edge for now. Two origins behind one path is a
    // failover story, and Nimble expresses it elsewhere; pretending a second
    // `to` exists would be inventing an API.
    if (ups.length > 1) add('multiple-upstreams-ignored', 'warn', { server: edgeServer.name, used: 1 });

    const originNode = ups[0];
    const originServer = byId.get(String(originNode.server));
    if (!originServer) { add('origin-server-missing', 'block', { server: edgeServer.name }); continue; }

    const addr = originAddress(originServer, edge.originHost || '');
    const port = originHttpPort(originServer);
    if (port.source === 'nimble-default') {
      add('origin-http-port-assumed', 'warn', {
        server: originServer.name, port: port.port,
        detail: 'httpPort is not set on the origin; Nimble\'s documented default is assumed',
      });
    }

    for (const application of channels) {
      const from = routeFrom(application);
      const to = routeTo(addr.host, port.port, application);

      // HTTP Origin on the edge turns it into a pass-through with no cache.
      const inOriginMode = originAppServers.get(application);
      if (inOriginMode?.has(String(edgeServer.wmspanelServerId))) {
        add('http-origin-disables-cache', 'block', {
          server: edgeServer.name, application,
          detail: 'this application is in HTTP Origin mode on this server, and HLS re-streaming '
                + 'is not cached while that is on — every viewer would fetch from the origin',
        });
        continue;
      }

      // Same `from` already claimed on this server by a route pointing
      // somewhere else. Creating a second one is not an update.
      const clash = existingRoutes.find(r =>
        (r.servers || []).map(String).includes(String(edgeServer.wmspanelServerId))
        && trimSlashes(r.from) === trimSlashes(from));
      if (clash) {
        if (clash.to === to) {
          planned.push({ action: 'keep', application, server: edgeServer.name,
                         wmspanelServerId: String(edgeServer.wmspanelServerId), from, to, routeId: clash.id });
        } else {
          planned.push({ action: 'update', application, server: edgeServer.name,
                         wmspanelServerId: String(edgeServer.wmspanelServerId), from, to,
                         routeId: clash.id, was: clash.to });
        }
        continue;
      }

      planned.push({
        action: 'create', application,
        server: edgeServer.name, wmspanelServerId: String(edgeServer.wmspanelServerId),
        origin: originServer.name, originHost: addr.host, originHostSource: addr.source,
        port: port.port, portSource: port.source,
        from, to,
      });
    }
  }

  return {
    planned,
    problems,
    blocking: problems.filter(p => p.severity === 'block'),
    summary: {
      create: planned.filter(p => p.action === 'create').length,
      update: planned.filter(p => p.action === 'update').length,
      keep: planned.filter(p => p.action === 'keep').length,
    },
  };
}
