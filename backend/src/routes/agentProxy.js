import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { Playlist } from '../models/Playlist.js';
import { agent } from '../services/agentClient.js';
import { logEvent } from '../services/audit.js';

export const agentRouter = Router();
agentRouter.use(requireAuth);

async function loadServer(req, res, next) {
  const s = await NimbleServer.findById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  req.srv = s;
  next();
}

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};

// --- connection management ---
agentRouter.get('/:id/agent', requirePerm('servers.view'), loadServer, (req, res) => {
  const a = req.srv.agent || {};
  res.json({ enabled: Boolean(a.enabled), baseUrl: a.baseUrl || '', hasToken: Boolean(a.token) });
});

agentRouter.put('/:id/agent', requirePerm('servers.manage'), loadServer, wrap(async (req) => {
  const { enabled, baseUrl, token } = req.body || {};
  req.srv.agent = req.srv.agent || {};
  if (enabled !== undefined) req.srv.agent.enabled = Boolean(enabled);
  if (baseUrl !== undefined) req.srv.agent.baseUrl = String(baseUrl).trim();
  if (token) req.srv.agent.token = String(token);   // empty means "keep current"
  await req.srv.save();
  logEvent({ req, action: 'agent:configure', target: req.srv.name, outcome: 'ok', status: 200 });
  return { ok: true };
}));

agentRouter.get('/:id/agent/health', requirePerm('servers.view'), loadServer,
  wrap(req => agent.health(req.srv)));

// --- config files ---
agentRouter.get('/:id/agent/config', requirePerm('playlist.view'), loadServer,
  wrap(req => agent.configGet(req.srv, String(req.query.name || ''))));

agentRouter.put('/:id/agent/config', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const name = String(req.query.name || req.body?.name || '');
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const r = await agent.configPut(req.srv, name, content);
  logEvent({ req, action: 'agent:config_write', target: `${req.srv.name}:${name} (${r.size} B)`, outcome: 'ok', status: 200 });
  return r;
}));

// Deploy a stored playlist straight to the server's config directory.
agentRouter.post('/:id/agent/deploy-playlist', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const pl = await Playlist.findById(req.body?.playlistId);
  if (!pl) throw Object.assign(new Error('Playlist not found'), { status: 404 });
  const name = String(req.body?.filename || 'playlist.json');
  const content = typeof req.body?.content === 'string' ? req.body.content : JSON.stringify(pl.model, null, 2);
  const r = await agent.configPut(req.srv, name, content);
  logEvent({ req, action: 'playlist:deploy', target: `${pl.name} → ${req.srv.name}:${name}`, outcome: 'ok', status: 200 });
  return { ...r, playlist: pl.name };
}));

// --- media ---
agentRouter.get('/:id/agent/media', requirePerm('playlist.view'), loadServer,
  wrap(req => agent.mediaList(req.srv)));

agentRouter.delete('/:id/agent/media', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const name = String(req.query.name || '');
  const r = await agent.mediaDelete(req.srv, name);
  logEvent({ req, action: 'agent:media_delete', target: `${req.srv.name}:${name}`, outcome: 'ok', status: 200 });
  return r;
}));

// Upload is streamed through: the panel never buffers a whole media file.
agentRouter.put('/:id/agent/media', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const name = String(req.query.name || '');
  const r = await agent.mediaPut(req.srv, name, req);
  logEvent({ req, action: 'agent:media_upload', target: `${req.srv.name}:${name} (${r.size} B)`, outcome: 'ok', status: 200 });
  return r;
}));
