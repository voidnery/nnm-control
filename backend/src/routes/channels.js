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
import { logEvent } from '../services/audit.js';

export const channelRouter = Router();
channelRouter.use(requireAuth);

const pub = (c) => ({
  id: c.id, application: c.application, stream: c.stream,
  label: c.label, notes: c.notes, kind: c.kind, enabled: c.enabled,
  network: c.network ? String(c.network) : null,
  name: channelName(c), updatedAt: c.updatedAt,
});

const trim = s => String(s || '').replace(/^\/+|\/+$/g, '');

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
