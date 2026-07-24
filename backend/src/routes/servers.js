import { Router } from 'express';
import { NimbleServer } from '../models/NimbleServer.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { nimble } from '../services/nimbleClient.js';
import { Settings } from '../models/Settings.js';
import { logEvent } from '../services/audit.js';

export const serversRouter = Router();

// Keep only well-formed endpoints; ports fall back to Nimble's defaults.
const cleanEndpoints = (list) => (Array.isArray(list) ? list : [])
  .filter(e => e && String(e.host || '').trim())
  .slice(0, 20)
  .map(e => ({
    label: String(e.label || '').trim(),
    host: String(e.host).trim(),
    hlsPort: Number(e.hlsPort) > 0 ? Number(e.hlsPort) : 8081,
    rtmpPort: Number(e.rtmpPort) > 0 ? Number(e.rtmpPort) : 1935,
    ssl: Boolean(e.ssl),
  }));
serversRouter.use(requireAuth);

// Token is never returned to the UI — only a hasToken flag.
const pub = (s) => ({
  id: s.id, name: s.name, host: s.host, port: s.port, useSsl: s.useSsl,
  tags: s.tags, notes: s.notes, hasToken: Boolean(s.token), wmspanelServerId: s.wmspanelServerId || '',
  order: s.order ?? 0,
  playbackEndpoints: (s.playbackEndpoints || []).map(e => ({ label: e.label || '', host: e.host, hlsPort: e.hlsPort, rtmpPort: e.rtmpPort, ssl: Boolean(e.ssl) })),
  syncedFromWmspanel: Boolean(s.syncedFromWmspanel), wmspanelStatus: s.wmspanelStatus || '', lastSyncAt: s.lastSyncAt, createdAt: s.createdAt,
});

serversRouter.get('/', requirePerm('servers.view'), async (_req, res) => {
  const servers = await NimbleServer.find().sort({ order: 1, name: 1 });
  res.json(servers.map(pub));
});

serversRouter.post('/', requirePerm('servers.manage'), async (req, res) => {
  const { name, host, port = 8082, token = '', useSsl = false, tags = [], notes = '', wmspanelServerId = '', playbackEndpoints = [] } = req.body || {};
  if (!name || !host) return res.status(400).json({ error: 'name and host required' });
  const server = await NimbleServer.create({ name, host, port, token, useSsl, tags, notes, wmspanelServerId, playbackEndpoints: cleanEndpoints(playbackEndpoints) });
  res.status(201).json(pub(server));
});

// Persist the operator's ordering. Declared before '/:id' so "order" can never
// be parsed as a server id.
serversRouter.put('/order', requirePerm('servers.manage'), async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  await NimbleServer.bulkWrite(ids.map((id, i) => ({
    updateOne: { filter: { _id: id }, update: { $set: { order: i } } },
  })));
  logEvent({ req, action: 'servers:reorder', target: `${ids.length} server(s)`, outcome: 'ok', status: 200 });
  res.json({ ok: true });
});

serversRouter.put('/:id', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  const { name, host, port, token, useSsl, tags, notes, wmspanelServerId, playbackEndpoints } = req.body || {};
  if (name !== undefined) server.name = name;
  if (host !== undefined) server.host = host;
  if (port !== undefined) server.port = port;
  // token semantics: undefined = keep, '' = clear, string = replace
  if (token !== undefined) server.token = token;
  if (useSsl !== undefined) server.useSsl = useSsl;
  if (tags !== undefined) server.tags = tags;
  if (notes !== undefined) server.notes = notes;
  if (wmspanelServerId !== undefined) server.wmspanelServerId = String(wmspanelServerId).trim();
  if (playbackEndpoints !== undefined) server.playbackEndpoints = cleanEndpoints(playbackEndpoints);
  await server.save();
  res.json(pub(server));
});

serversRouter.delete('/:id', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findByIdAndDelete(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Connectivity test — hits /manage/server_status (native API; backup mode only).
serversRouter.post('/:id/test', requirePerm('servers.view'), async (req, res) => {
  const settings = await Settings.load();
  if (settings.controlPlane === 'wmspanel') {
    return res.status(409).json({ error: 'Native API test is disabled: control plane is WMSPanel API' });
  }
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  try {
    const status = await nimble.serverStatus(server);
    res.json({ ok: true, status });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
