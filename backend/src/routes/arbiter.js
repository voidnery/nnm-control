import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { DeliveryNetwork, GATEWAY_MODES, GATEWAY_POLICIES } from '../models/DeliveryNetwork.js';
import { chooseEdge, viewerUrl, routingTable } from '../services/arbiter.js';
import { lookup as geoLookup } from '../services/geoip.js';
import { networkState, indexStreams } from '../services/networkState.js';
import { nimble } from '../services/nimbleClient.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { Settings } from '../models/Settings.js';
import { logEvent } from '../services/audit.js';
const cfg = async () => (await Settings.load()).wmspanel;

export const arbiterRouter = Router();

// Collecting the edges with everything a policy might need. Gathered once and
// passed in, so the choice itself stays a pure function of known state.
async function edgesOf(networkId, channel) {
  const network = await DeliveryNetwork.findById(networkId);
  if (!network) return { error: 'Network not found' };
  const servers = await NimbleServer.find();
  const byId = new Map(servers.map(s => [String(s._id), s]));
  const g0Routes = await wmspanel.routeList(await cfg()).then(r => r.routes || []).catch(() => null);

  const edgeNodes = (network.nodes || []).filter(n => n.role === 'edge' && n.enabled !== false);
  const edges = [];
  for (const n of edgeNodes) {
    const s = byId.get(String(n.server));
    if (!s) continue;
    // Configured routes decide eligibility; live streams are a reading. See
    // the deadlock documented in arbiter.candidates().
    const routes = g0Routes === null ? undefined : g0Routes.filter(r => (r.servers || []).map(String).includes(String(s.wmspanelServerId)))
      .map(r => String(r.from || '').replace(/^\/+|\/+$/g, ''));
    let channels, healthy = true;
    try {
      const idx = indexStreams(await nimble.liveStreams(s));
      channels = [...idx.keys()];
    } catch {
      // Unreachable is not the same as empty. A box the panel could not ask
      // keeps `channels` undefined, which the arbiter treats as "unknown" and
      // still considers — shrinking the network on a failed poll would be a
      // worse failure than the poll.
      channels = undefined;
      healthy = false;
    }
    edges.push({
      name: s.name, host: s.host,
      // A public name, from wherever the operator already put one. WMSPanel's
      // custom domains count: they are the same answer to the same question,
      // and requiring it to be retyped as a playback endpoint is how the panel
      // told an operator their edges had no names while WMSPanel listed three.
      publicHost: s.playbackEndpoints?.[0]?.host || s.wmspanelDomains?.[0] || '',
      httpPort: s.httpPort || 8081,
      weight: n.weight ?? 100, enabled: n.enabled !== false, healthy, routes,
      lat: s.geo?.lat ?? null, lon: s.geo?.lon ?? null,
      channels,
    });
  }
  const node = network.gateway?.node ? byId.get(String(network.gateway.node)) : null;
  return { network, edges, node };
}

// What a viewer would be handed, shown to the operator before anyone is sent
// anywhere. The reasoning comes back with it: an operator asking "why would
// this viewer go to Frankfurt" deserves the comparison, not a shrug.
arbiterRouter.post('/networks/:id/resolve-preview', requireAuth, requirePerm('cdn.view'), async (req, res) => {
  const channel = String(req.body?.channel || '').trim();
  const stream = String(req.body?.stream || '').trim() || '<stream>';
  const g = await edgesOf(req.params.id, channel);
  if (g.error) return res.status(404).json({ error: g.error });

  // A viewer position, either given explicitly or looked up from an address
  // the operator is testing with.
  let viewer = null, viewerFrom = 'none';
  const ip = String(req.body?.viewerIp || '').trim();
  if (Number.isFinite(Number(req.body?.lat)) && Number.isFinite(Number(req.body?.lon))) {
    viewer = { lat: Number(req.body.lat), lon: Number(req.body.lon) };
    viewerFrom = 'coordinates';
  } else if (ip) {
    const r = await geoLookup(ip);
    if (r.ok && r.hasCoordinates) { viewer = { lat: r.lat, lon: r.lon }; viewerFrom = 'geoip'; }
    else viewerFrom = r.reason || 'not-located';
  }

  const gw = g.network.gateway || {};
  const decision = chooseEdge(g.edges, { policy: gw.policy || 'nearest', viewer, channel });
  if (!decision.edge) {
    return res.json({
      decision, viewerFrom,
      // The configured answer to "nobody is healthy", surfaced rather than
      // silently applied.
      whenAllDown: gw.whenAllDown || 'fail',
      url: null,
    });
  }
  const link = viewerUrl({
    mode: gw.mode || 'direct', domain: gw.domain || '', node: g.node,
    edge: decision.edge, channel, stream,
  });
  res.json({ decision, viewerFrom, mode: gw.mode || 'direct', ...link });
});

// The table a gateway node needs to decide without asking the panel.
arbiterRouter.get('/networks/:id/routing-table', requireAuth, requirePerm('cdn.view'), async (req, res) => {
  const channels = String(req.query.channels || '').split(/[\s,]+/).filter(Boolean);
  const g = await edgesOf(req.params.id);
  if (g.error) return res.status(404).json({ error: g.error });
  const table = routingTable({ network: g.network, edges: g.edges, channels });
  res.json({ ...table, generatedAt: new Date().toISOString() });
});

arbiterRouter.put('/networks/:id/gateway', requireAuth, requirePerm('cdn.manage'), async (req, res) => {
  const n = await DeliveryNetwork.findById(req.params.id);
  if (!n) return res.status(404).json({ error: 'Network not found' });
  const b = req.body || {};
  if (b.mode !== undefined && !GATEWAY_MODES.includes(b.mode)) {
    return res.status(400).json({ error: 'unknown-mode', code: 'unknown-mode' });
  }
  if (b.policy !== undefined && !GATEWAY_POLICIES.includes(b.policy)) {
    return res.status(400).json({ error: 'unknown-policy', code: 'unknown-policy' });
  }
  // A gateway that carries traffic needs a machine to carry it on. Refusing
  // here beats a mode that is set, looks configured, and resolves to nothing.
  const mode = b.mode ?? n.gateway.mode;
  const node = b.node !== undefined ? (b.node || null) : n.gateway.node;
  if (mode !== 'direct' && !node) {
    return res.status(422).json({ error: 'gateway-needs-node', code: 'gateway-needs-node' });
  }
  Object.assign(n.gateway, {
    enabled: b.enabled ?? n.gateway.enabled,
    mode, node,
    domain: (b.domain ?? n.gateway.domain).trim(),
    policy: b.policy ?? n.gateway.policy,
    whenAllDown: b.whenAllDown ?? n.gateway.whenAllDown,
  });
  await n.save();
  await logEvent(req, 'cdn.gateway.update', { network: n.name, mode, policy: n.gateway.policy });

  // Whether the machine's nginx knows about these edges yet.
  //
  // The config is written once, when the machine is prepared — and a machine
  // is prepared before it joins a network, so it points at `edge.invalid`, a
  // placeholder that never resolves. Saving the network here changes the
  // panel's model and nothing on the machine, so a proxy gateway configured
  // this way accepts viewers and forwards them nowhere.
  //
  // Reported rather than silently rewritten: rewriting nginx from a settings
  // save would be a config change nobody asked for at a moment nobody expects
  // it. The operator re-runs the preparation, which is one button and shows
  // what it will do first.
  let staleConfig = null;
  if (mode === 'proxy' && node) {
    const machine = await NimbleServer.findById(node).catch(() => null);
    const edges = (n.nodes || []).filter(x => x.role === 'edge');
    if (machine?.gateway?.state === 'applied' && edges.length) {
      const preparedAt = machine.gateway.at ? new Date(machine.gateway.at).getTime() : 0;
      staleConfig = {
        machine: machine.name,
        preparedAt: machine.gateway.at,
        edges: edges.length,
        // Prepared before the edges existed in this network, so the config it
        // wrote cannot name them.
        why: 'prepared-before-edges',
        stale: preparedAt < new Date(n.updatedAt || 0).getTime(),
      };
    }
  }

  res.json({ gateway: n.gateway, modes: GATEWAY_MODES, policies: GATEWAY_POLICIES, staleConfig });
});
