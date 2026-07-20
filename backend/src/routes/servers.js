import { Router } from 'express';
import { NimbleServer } from '../models/NimbleServer.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { nimble } from '../services/nimbleClient.js';

export const serversRouter = Router();
serversRouter.use(requireAuth);

// Token is never returned to the UI — only a hasToken flag.
const pub = (s) => ({
  id: s.id, name: s.name, host: s.host, port: s.port, useSsl: s.useSsl,
  tags: s.tags, notes: s.notes, hasToken: Boolean(s.token), wmspanelServerId: s.wmspanelServerId || '',
  syncedFromWmspanel: Boolean(s.syncedFromWmspanel), wmspanelStatus: s.wmspanelStatus || '', lastSyncAt: s.lastSyncAt, createdAt: s.createdAt,
});

serversRouter.get('/', requirePerm('servers.view'), async (_req, res) => {
  const servers = await NimbleServer.find().sort({ name: 1 });
  res.json(servers.map(pub));
});

serversRouter.post('/', requirePerm('servers.manage'), async (req, res) => {
  const { name, host, port = 8082, token = '', useSsl = false, tags = [], notes = '', wmspanelServerId = '' } = req.body || {};
  if (!name || !host) return res.status(400).json({ error: 'name and host required' });
  const server = await NimbleServer.create({ name, host, port, token, useSsl, tags, notes, wmspanelServerId });
  res.status(201).json(pub(server));
});

serversRouter.put('/:id', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  const { name, host, port, token, useSsl, tags, notes, wmspanelServerId } = req.body || {};
  if (name !== undefined) server.name = name;
  if (host !== undefined) server.host = host;
  if (port !== undefined) server.port = port;
  // token semantics: undefined = keep, '' = clear, string = replace
  if (token !== undefined) server.token = token;
  if (useSsl !== undefined) server.useSsl = useSsl;
  if (tags !== undefined) server.tags = tags;
  if (notes !== undefined) server.notes = notes;
  if (wmspanelServerId !== undefined) server.wmspanelServerId = String(wmspanelServerId).trim();
  await server.save();
  res.json(pub(server));
});

serversRouter.delete('/:id', requirePerm('servers.manage'), async (req, res) => {
  const server = await NimbleServer.findByIdAndDelete(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Connectivity test — hits /manage/server_status.
serversRouter.post('/:id/test', requirePerm('servers.view'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  try {
    const status = await nimble.serverStatus(server);
    res.json({ ok: true, status });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
