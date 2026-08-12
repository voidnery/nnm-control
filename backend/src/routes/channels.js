import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { Channel, channelName } from '../models/Channel.js';
import { DeliveryNetwork } from '../models/DeliveryNetwork.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { Settings } from '../models/Settings.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { nimble, agentIsLive } from '../services/nimbleClient.js';
import { indexStreams } from '../services/networkState.js';
import { channelLinks } from '../services/channelLinks.js';
import { derivePlan, channelReadiness } from '../services/derivePlan.js';
import { networkSteps } from '../services/networkSteps.js';
import { logEvent } from '../services/audit.js';

export const channelRouter = Router();
channelRouter.use(requireAuth);

const pub = (c) => ({
  id: c.id, application: c.application, stream: c.stream,
  label: c.label, notes: c.notes, kind: c.kind, enabled: c.enabled,
  protocol: c.protocol || 'hls',
  network: c.network ? String(c.network) : null,
  name: channelName(c), updatedAt: c.updatedAt,
});

const trim = s => String(s || '').replace(/^\/+|\/+$/g, '');

// What the origins are publishing that is not a channel yet.
//
// Adding a channel used to mean typing an application and a stream that the
// origin already knows, and a name typed twice is a name eventually typed
// wrong. This offers them — across every network, since a stream is worth
// delivering regardless of which network the operator happens to be looking
// at, and the network is chosen when the channel is created.
channelRouter.get('/channels/discovered', requirePerm('cdn.view'), async (_req, res) => {
  const [networks, servers, existing] = await Promise.all([
    DeliveryNetwork.find(), NimbleServer.find(), Channel.find(),
  ]);
  const byId = new Map(servers.map(s => [String(s._id), s]));
  const have = new Set(existing.map(c => `${trim(c.application)}/${trim(c.stream)}`));

  // Origins and ingests only. An edge is publishing what it pulled, so
  // offering its streams would suggest creating a channel for something that
  // is already a copy of one.
  const sources = new Map();
  for (const n of networks) {
    for (const node of n.nodes || []) {
      if (!['origin', 'ingest'].includes(node.role) || node.enabled === false) continue;
      const s = byId.get(String(node.server));
      if (s) sources.set(String(s._id), s);
    }
  }

  const found = [];
  const unreachable = [];
  await Promise.all([...sources.values()].map(async (s) => {
    let idx;
    try { idx = indexStreams(await nimble.liveStreams(s)); }
    catch { unreachable.push(s.name); return; }
    for (const [application, entries] of idx) {
      for (const e of entries) {
        const stream = trim(e.stream);
        if (!stream) continue;
        const key = `${application}/${stream}`;
        if (have.has(key)) continue;
        if (!found.some(f => f.key === key)) {
          found.push({ key, application, stream, origin: s.name, bandwidth: e.bandwidth || 0 });
        }
      }
    }
  }));
  found.sort((a, b) => a.key.localeCompare(b.key));
  res.json({ found, unreachable });
});

channelRouter.get('/channels', requirePerm('cdn.view'), async (_req, res) => {
  const items = await Channel.find().sort({ application: 1, stream: 1 });
  res.json({ channels: items.map(pub) });
});

channelRouter.post('/channels', requirePerm('cdn.manage'), async (req, res) => {
  const application = trim(req.body?.application);
  const stream = trim(req.body?.stream);
  if (!application || !stream) {
    return res.status(400).json({ error: 'application-and-stream-required', code: 'application-and-stream-required' });
  }
  if (await Channel.findOne({ application, stream })) {
    // The pair is the identity. Two records claiming one stream would make
    // "the production link for this channel" ambiguous, which is worse than
    // having no answer.
    return res.status(409).json({ error: 'channel-exists', code: 'channel-exists' });
  }
  const c = await Channel.create({
    application, stream,
    label: String(req.body?.label || ''), notes: String(req.body?.notes || ''),
    kind: req.body?.kind === 'test' ? 'test' : 'production',
    protocol: ['hls', 'llhls', 'dash'].includes(req.body?.protocol) ? req.body.protocol : 'hls',
    network: req.body?.network || null,
    createdBy: req.user?.username || '',
  });
  await logEvent(req, 'cdn.channel.create', { application, stream });
  res.status(201).json(pub(c));
});

channelRouter.put('/channels/:id', requirePerm('cdn.manage'), async (req, res) => {
  const c = await Channel.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'channel-not-found', code: 'channel-not-found' });
  const b = req.body || {};
  if (b.label !== undefined) c.label = String(b.label);
  if (b.notes !== undefined) c.notes = String(b.notes);
  if (b.kind !== undefined) c.kind = b.kind === 'test' ? 'test' : 'production';
  if (b.protocol !== undefined && ['hls', 'llhls', 'dash'].includes(b.protocol)) c.protocol = b.protocol;
  if (b.enabled !== undefined) c.enabled = b.enabled !== false;
  if (b.network !== undefined) c.network = b.network || null;
  try { await c.save(); }
  catch (e) { return res.status(422).json({ error: `channel-not-saved`, code: 'channel-not-saved', detail: e.message }); }
  await logEvent(req, 'cdn.channel.update', { id: c.id });
  res.json(pub(c));
});

channelRouter.delete('/channels/:id', requirePerm('cdn.manage'), async (req, res) => {
  const c = await Channel.findByIdAndDelete(req.params.id);
  if (!c) return res.status(404).json({ error: 'channel-not-found', code: 'channel-not-found' });
  await logEvent(req, 'cdn.channel.delete', { application: c.application, stream: c.stream });
  res.json({ ok: true });
});

// Edges of a network, with everything the link generator and the dashboard
// need. Shaped like the arbiter's own gathering because it answers the same
// question and must not answer it differently.
async function edgesOf(network, servers, routes) {
  const byId = new Map(servers.map(s => [String(s._id), s]));
  const out = [];
  for (const n of (network.nodes || []).filter(x => x.role === 'edge' && x.enabled !== false)) {
    const s = byId.get(String(n.server));
    if (!s) continue;
    const mine = routes === null ? undefined
      : routes.filter(r => (r.servers || []).map(String).includes(String(s.wmspanelServerId)))
              .map(r => trim(r.from));
    let channels, healthy = true;
    try { channels = [...indexStreams(await nimble.liveStreams(s)).keys()]; }
    catch { channels = undefined; healthy = false; }
    out.push({
      name: s.name, host: s.host,
      publicHost: s.playbackEndpoints?.[0]?.host || s.wmspanelDomains?.[0] || '',
      httpPort: s.httpPort || 8081,
      weight: n.weight ?? 100, enabled: true, healthy,
      lat: s.geo?.lat ?? null, lon: s.geo?.lon ?? null,
      routes: mine, channels, hasAgent: agentIsLive(s),
    });
  }
  return out;
}

// What a network needs written so its channels are delivered, and why.
//
// The operator adds channels; this works out the rest. Same computation drives
// the preview and the apply, so the two cannot disagree — which is the only
// thing that makes it acceptable for the panel to write into the account
// without asking each time.
channelRouter.get('/networks/:id/derived', requirePerm('cdn.view'), async (req, res) => {
  const [network, servers, channels] = await Promise.all([
    DeliveryNetwork.findById(req.params.id),
    NimbleServer.find(),
    Channel.find({ network: req.params.id, enabled: true }),
  ]);
  if (!network) return res.status(404).json({ error: 'network-not-found', code: 'network-not-found' });
  const cfg = (await Settings.load()).wmspanel;
  const [originApps, routes] = await Promise.all([
    wmspanel.originAppList(cfg).then(r => r.settings || []).catch(() => []),
    wmspanel.routeList(cfg).then(r => r.routes || []).catch(() => []),
  ]);
  const plan = derivePlan({ network, servers, channels, originApps, existingRoutes: routes });
  res.json({
    ...plan,
    channels: channels.map(c => ({ ...pub(c), readiness: channelReadiness({ channel: c, plan }) })),
    // The six steps, computed from the same data rather than inferred by the
    // page: a tick has to mean the thing is true, and two places working that
    // out would eventually disagree about what green means.
    //
    // `watched` is not included. Whether content actually arrives is not
    // derivable from configuration — it takes a probe — so the step is empty
    // until the operator runs one, and the page passes the result back in.
    steps: networkSteps({ network, servers, channels, derived: plan }),
  });
});

// One row per channel: where it is delivered, whether anything is arriving,
// and the links to hand out. The question the panel could not answer about its
// own configuration.
channelRouter.get('/channels/overview', requirePerm('cdn.view'), async (_req, res) => {
  const [channels, networks, servers] = await Promise.all([
    Channel.find().sort({ application: 1, stream: 1 }),
    DeliveryNetwork.find(),
    NimbleServer.find(),
  ]);
  const cfg = (await Settings.load()).wmspanel;
  // Null rather than [] when the list could not be read: "we did not ask" and
  // "there are none" lead to different rows.
  const routes = await wmspanel.routeList(cfg).then(r => r.routes || []).catch(() => null);

  const byNetwork = new Map();
  for (const n of networks) byNetwork.set(String(n._id), n);
  const edgeCache = new Map();
  const rows = [];

  for (const c of channels) {
    const net = c.network ? byNetwork.get(String(c.network)) : null;
    if (!net) {
      // A stream nobody delivers. Invisible before, and exactly the thing
      // worth seeing before an event rather than during one.
      rows.push({ channel: pub(c), network: null, edges: [], links: null, code: 'not-delivered' });
      continue;
    }
    if (!edgeCache.has(String(net._id))) edgeCache.set(String(net._id), await edgesOf(net, servers, routes));
    const edges = edgeCache.get(String(net._id));
    const gwNode = net.gateway?.node ? servers.find(s => String(s._id) === String(net.gateway.node)) : null;
    rows.push({
      channel: pub(c),
      network: { id: net.id, name: net.name, audience: net.audience },
      edges: edges.map(e => ({
        name: e.name, healthy: e.healthy,
        routed: e.routes ? e.routes.includes(c.application) : null,
        serving: e.channels ? e.channels.includes(c.application) : null,
      })),
      links: channelLinks({ channel: c, network: net, edges, node: gwNode }),
    });
  }
  res.json({ rows, routesRead: routes !== null });
});
