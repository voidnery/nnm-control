import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { Playlist } from '../models/Playlist.js';
import { runTask, enqueueTask, reapExpiredTasks } from '../services/agentBus.js';
import { AgentTask } from '../models/AgentTask.js';
import { diagnose, HINTS } from '../services/agentDiagnosis.js';
import { MediaTransfer } from '../models/MediaTransfer.js';
import { spoolUpload, spoolUsage } from '../services/mediaSpool.js';
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
  res.json({
    enabled: Boolean(a.enabled), hasToken: Boolean(a.token),
    lastContactAt: a.lastContactAt || null, version: a.version || 0,
    interfaces: a.interfaces || [],
    // What the agent last reported it has, so the operator picks from a real
    // list rather than typing a name that may not exist on that box.
    availableInterfaces: a.lastHealth?.interfaces || [],
  });
});

agentRouter.put('/:id/agent', requirePerm('servers.manage'), loadServer, wrap(async (req) => {
  const { enabled, token, interfaces } = req.body || {};
  if (Array.isArray(interfaces)) {
    req.srv.agent.interfaces = interfaces
      .map(x => String(x).trim())
      .filter(x => /^[A-Za-z0-9_.@:-]{1,32}$/.test(x))
      .slice(0, 12);
  }
  req.srv.agent = req.srv.agent || {};
  if (enabled !== undefined) req.srv.agent.enabled = Boolean(enabled);
  if (token) req.srv.agent.token = String(token);   // empty means "keep current"
  await req.srv.save();
  logEvent({ req, action: 'agent:configure', target: req.srv.name, outcome: 'ok', status: 200 });
  return { ok: true };
}));

// iter12 m1 — health and config now travel over the task bus instead of a
// connection to the agent. The browser still gets its answer in this response;
// what changed is that the panel asks by queueing and waiting, so the server
// no longer has to be reachable from here.
agentRouter.get('/:id/agent/health', requirePerm('servers.view'), loadServer,
  wrap(req => runTask(req.srv, 'GET /health', { createdBy: req.user?.username })));

// iter12 m4 — why is this agent not doing what was asked?
//
// The states are read fresh, and expired tasks are reaped first: a task
// sitting past its deadline still marked `queued` would be read as a
// panel-side claim failure, which is a confident wrong answer.
agentRouter.get('/:id/agent/diagnosis', requirePerm('servers.view'), loadServer, wrap(async (req) => {
  await reapExpiredTasks();
  const a = req.srv.agent || {};
  const tasks = await AgentTask.find({ serverId: req.srv._id })
    .sort({ createdAt: -1 }).limit(25).lean();
  const d = diagnose({
    now: new Date(),
    agent: {
      enabled: Boolean(a.enabled),
      hasToken: Boolean(a.token),
      lastContactAt: a.lastContactAt,
      instanceId: a.instanceId,
      version: a.version,
      restarts: a.restarts,
      restartWindowStart: a.restartWindowStart,
    },
    tasks: tasks.map(t => ({
      id: String(t._id), route: t.route, status: t.status,
      createdAt: t.createdAt, claimedAt: t.claimedAt, deadlineAt: t.deadlineAt,
    })),
  });
  return {
    ...d,
    hint: HINTS[d.code] || '',
    agentVersion: a.version || 0,
    instanceId: a.instanceId || '',
    recent: tasks.slice(0, 8).map(t => ({
      route: t.route, status: t.status, createdAt: t.createdAt,
      claimedAt: t.claimedAt, finishedAt: t.finishedAt, error: t.error,
    })),
  };
}));

// --- config files ---
agentRouter.get('/:id/agent/config', requirePerm('playlist.view'), loadServer,
  wrap(req => runTask(req.srv, 'GET /config', {
    query: { name: String(req.query.name || '') }, createdBy: req.user?.username,
  })));

agentRouter.put('/:id/agent/config', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const name = String(req.query.name || req.body?.name || '');
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const r = await runTask(req.srv, 'PUT /config', {
    query: { name }, body: { content }, createdBy: req.user?.username,
  });
  logEvent({ req, action: 'agent:config_write', target: `${req.srv.name}:${name} (${r.size} B)`, outcome: 'ok', status: 200 });
  return r;
}));

// Deploy a stored playlist straight to the server's config directory.
agentRouter.post('/:id/agent/deploy-playlist', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const pl = await Playlist.findById(req.body?.playlistId);
  if (!pl) throw Object.assign(new Error('Playlist not found'), { status: 404 });
  const name = String(req.body?.filename || 'playlist.json');
  const content = typeof req.body?.content === 'string' ? req.body.content : JSON.stringify(pl.model, null, 2);
  const r = await runTask(req.srv, 'PUT /config', { query: { name }, body: { content }, createdBy: req.user?.username });
  logEvent({ req, action: 'playlist:deploy', target: `${pl.name} → ${req.srv.name}:${name}`, outcome: 'ok', status: 200 });
  return { ...r, playlist: pl.name };
}));

// --- media ---
agentRouter.get('/:id/agent/media', requirePerm('playlist.view'), loadServer,
  wrap(req => runTask(req.srv, 'GET /media', { createdBy: req.user?.username })));

agentRouter.delete('/:id/agent/media', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const name = String(req.query.name || '');
  const r = await runTask(req.srv, 'DELETE /media', { query: { name }, createdBy: req.user?.username });
  logEvent({ req, action: 'agent:media_delete', target: `${req.srv.name}:${name}`, outcome: 'ok', status: 200 });
  return r;
}));

// iter12 m3 — the operator hands the file to the panel; the agent collects it.
//
// The browser's upload is streamed to the panel's spool and the response comes
// back as soon as it is safely on disk — it deliberately does NOT wait for the
// agent. A 2 GB file over a slow link would otherwise hold an HTTP request
// open for minutes and fail the whole upload if the server happened to be
// offline, which is precisely the case this design exists to handle.
agentRouter.put('/:id/agent/media', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const name = String(req.query.name || '');
  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });
  const doc = await spoolUpload(req.srv, name, req, { createdBy: req.user?.username });
  await enqueueTask(req.srv, 'POST /media/fetch', {
    body: { transferId: String(doc._id), name: doc.name, sha256: doc.sha256, size: doc.size },
    timeoutMs: 30 * 60_000,          // a large file over a slow link
    createdBy: req.user?.username,
  });
  logEvent({ req, action: 'agent:media_upload', target: `${req.srv.name}:${name} (${doc.size} B)`, outcome: 'ok', status: 200 });
  return { queued: true, transferId: String(doc._id), name: doc.name, size: doc.size, sha256: doc.sha256 };
}));

// What is still in flight, and what the spool is costing in disk.
agentRouter.get('/:id/agent/transfers', requirePerm('playlist.view'), loadServer, wrap(async (req) => {
  const items = await MediaTransfer.find({ serverId: req.srv._id }).sort({ createdAt: -1 }).limit(50).lean();
  return {
    spool: await spoolUsage(),
    transfers: items.map(t => ({
      id: String(t._id), name: t.name, size: t.size, status: t.status, error: t.error,
      attempts: t.attempts, createdAt: t.createdAt, confirmedAt: t.confirmedAt, expiresAt: t.expiresAt,
    })),
  };
}));

// Re-queue a transfer whose file is still on the panel.
agentRouter.post('/:id/agent/transfers/:tid/retry', requirePerm('playlist.manage'), loadServer, wrap(async (req) => {
  const doc = await MediaTransfer.findOne({ _id: req.params.tid, serverId: req.srv._id });
  if (!doc) throw Object.assign(new Error('no such transfer'), { status: 404 });
  if (!doc.spoolPath) throw Object.assign(new Error('the file is no longer held by the panel — upload it again'), { status: 410 });
  doc.status = 'queued';
  doc.error = '';
  await doc.save();
  await enqueueTask(req.srv, 'POST /media/fetch', {
    body: { transferId: String(doc._id), name: doc.name, sha256: doc.sha256, size: doc.size },
    timeoutMs: 30 * 60_000,
    createdBy: req.user?.username,
  });
  return { ok: true, status: doc.status };
}));
