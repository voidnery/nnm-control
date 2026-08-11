// What is switched on, where, and what that costs — in one place.
//
// The settings that decide how a delivery network behaves are spread across
// four tabs and two other pages: the gateway mode here, HTTP Origin on account
// objects there, agents on the servers page, ports in a server dialog,
// coordinates under Geography. An operator asking "what is actually enabled"
// had to visit all of them and hold the answer in their head.
//
// Worse, several of these interact in ways that are invisible from either
// side. HTTP Origin on an edge silently disables its cache. A missing httpPort
// makes every route target a guessed number. A policy of "nearest" over edges
// with no coordinates is a policy that never runs. None of those is an error
// anywhere; each is a configuration that does something other than it reads.
//
// So this is not a settings dump. It is the set of things that are true and
// worth knowing, each with what to do about it — and, like the error contract,
// every code here must have a sentence and a fix in both dictionaries, which
// audit:config enforces.

const trim = s => String(s || '').replace(/^\/+|\/+$/g, '');

export function configOverview({ network, servers, originApps = [], routes = [], geo = null, channels = [] }) {
  const byId = new Map(servers.map(s => [String(s._id ?? s.id), s]));
  const nodes = (network?.nodes || []).filter(n => n.enabled !== false);
  const node = (n) => byId.get(String(n.server));
  const gw = network?.gateway || {};

  const findings = [];
  const add = (code, severity, subject, extra = {}) =>
    findings.push({ code, severity, subject, ...extra });

  // ------------------------------------------------------------- the shape
  const roles = {};
  for (const n of nodes) roles[n.role] = (roles[n.role] || 0) + 1;
  const edges = nodes.filter(n => n.role === 'edge');
  const origins = nodes.filter(n => n.role === 'origin');

  if (!origins.length) add('no-origin', 'block', network?.name || '');
  if (!edges.length) add('no-edges', 'warn', network?.name || '');
  for (const n of nodes) {
    // Only a mid or an edge is fed from inside this network. An origin is fed
    // by whatever publishes into it — an encoder, vMix, an SRT caller — none
    // of which the panel models, so "takes content from nothing" about an
    // origin describes the normal case and demands an action that does not
    // exist. It was the first thing an operator asked about on a network that
    // was working.
    if (['mid', 'edge'].includes(n.role) && !(n.upstream || []).length) {
      add('node-without-upstream', 'warn', node(n)?.name || String(n.id));
    }
  }

  // ----------------------------------------------------- per-server truths
  for (const n of nodes) {
    const s = node(n);
    if (!s) { add('node-server-missing', 'block', String(n.id)); continue; }

    if (!s.wmspanelServerId) add('server-not-in-wmspanel', 'block', s.name);

    // A route's target port comes from here. Unset means every route this
    // network writes aims at Nimble's documented default — which is a guess
    // that happens to be right until it is not, and then produces a route
    // that resolves and never serves.
    // Not "you forgot": WMSPanel holds custom ports in its own dialog and its
    // API returns none of them — checked against a full inventory of the
    // account, where the operator's second HTTP port appears in no response at
    // all. The panel cannot read it and has to be told separately, and saying
    // "not set" to someone who set it in WMSPanel sends them to look where it
    // already is.
    if (n.role === 'origin' && !(Number(s.httpPort) > 0)) add('origin-port-unknown', 'warn', s.name);

    // Without an agent the panel dials the box directly. It works while the
    // box is reachable, and stops silently the first time one sits behind NAT.
    if (!s.agent?.enabled) add('node-without-agent', 'note', s.name);
    else if (s.agent?.version != null && s.agent.version < 20) {
      add('agent-cannot-probe', 'note', s.name, { have: s.agent.version, need: 20 });
    }

    // "Nearest" over an edge with no position is a policy that cannot rank it.
    // A redirect gateway needs a name per edge. WMSPanel may already have one.
    if (n.role === 'edge' && gw.mode === 'redirect'
        && !(s.playbackEndpoints || []).length && (s.wmspanelDomains || []).length) {
      add('edge-domain-available', 'note', s.name, { domain: s.wmspanelDomains[0] });
    }
    if (n.role === 'edge' && gw.policy === 'nearest'
        && !(Number.isFinite(s.geo?.lat) && Number.isFinite(s.geo?.lon))) {
      add('edge-without-coordinates', 'warn', s.name);
    }
  }

  // ------------------------------------------------ interactions that hide
  //
  // The one that costs money. Softvelum are explicit that HLS re-streaming is
  // not cached while HTTP Origin mode is on, and nothing on either screen says
  // the two are related.
  const edgeWmsIds = new Set(edges.map(n => node(n)?.wmspanelServerId).filter(Boolean).map(String));
  const wantedApps = channels.map(trim).filter(Boolean);
  for (const oa of originApps) {
    const on = (oa.server_ids || []).map(String).filter(id => edgeWmsIds.has(id));
    if (!on.length) continue;
    const names = [...edgeWmsIds].filter(id => on.includes(id))
      .map(id => servers.find(s => String(s.wmspanelServerId) === id)?.name)
      .filter(Boolean);
    // Blocking only when this network actually delivers that application.
    // An unrelated app in HTTP Origin mode on a box that happens to be an edge
    // here costs nothing, and reporting it in red taught the operator that red
    // means "probably nothing". Without a channel list the panel does not know
    // which it is, and says so instead of picking the alarming reading.
    const delivered = wantedApps.includes(trim(oa.application));
    add(delivered ? 'http-origin-on-edge' : 'http-origin-on-edge-maybe',
        delivered ? 'block' : 'note', names.join(', '), { application: oa.application });
  }

  // ------------------------------------------------------------- the routes
  const wanted = channels.map(trim).filter(Boolean);
  for (const n of edges) {
    const s = node(n);
    if (!s?.wmspanelServerId) continue;
    const mine = routes.filter(r => (r.servers || []).map(String).includes(String(s.wmspanelServerId)));
    for (const r of mine) {
      if (wanted.length && !wanted.includes(trim(r.from))) {
        add('route-not-in-plan', 'note', s.name, { from: r.from, to: r.to });
      }
    }
    for (const c of wanted) {
      if (!mine.some(r => trim(r.from) === c)) add('channel-without-route', 'warn', s.name, { application: c });
    }
  }

  // ------------------------------------------------------------ the gateway
  if (gw.mode && gw.mode !== 'direct') {
    if (!gw.node) add('gateway-without-node', 'block', network?.name || '');
    else {
      const gs = byId.get(String(gw.node));
      if (!gs) add('gateway-node-missing', 'block', network?.name || '');
      else if (!gs.agent?.enabled) add('gateway-node-without-agent', 'block', gs.name);
    }
    if (!gw.domain) add('gateway-without-domain', 'warn', network?.name || '');
  }
  // A redirect gateway hands the viewer an edge address unless the edges have
  // names of their own. It is the configuration people set up believing it
  // hides them.
  if (gw.mode === 'redirect') {
    const bare = edges.map(node)
      .filter(s => s && !(s.playbackEndpoints || []).length && !(s.wmspanelDomains || []).length)
      .map(s => s.name);
    if (bare.length) add('redirect-reveals-edges', 'warn', bare.join(', '));
  }

  // ----------------------------------------------------------------- geo db
  if (!geo?.present) add('no-geo-database', gw.policy === 'nearest' ? 'warn' : 'note', '');
  else if (!geo.hasCoordinates && gw.policy === 'nearest') add('geo-database-has-no-coordinates', 'warn', geo.edition || '');

  const rank = { block: 0, warn: 1, note: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    // The settings themselves, so the answer to "what is enabled" does not
    // require reading the findings backwards.
    summary: {
      roles,
      gateway: {
        mode: gw.mode || 'direct', policy: gw.policy || 'nearest',
        whenAllDown: gw.whenAllDown || 'fail',
        domain: gw.domain || '', node: gw.node ? (byId.get(String(gw.node))?.name || '') : '',
      },
      audience: network?.audience || 'internal',
      geo: geo ? { present: Boolean(geo.present), edition: geo.edition || '', hasCoordinates: Boolean(geo.hasCoordinates) } : null,
      routes: routes.length,
      agents: nodes.filter(n => node(n)?.agent?.enabled).length,
      nodes: nodes.length,
    },
    findings,
    counts: {
      block: findings.filter(f => f.severity === 'block').length,
      warn: findings.filter(f => f.severity === 'warn').length,
      note: findings.filter(f => f.severity === 'note').length,
    },
  };
}
