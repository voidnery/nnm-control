import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { Category } from '../models/Category.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { Settings } from '../models/Settings.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { KIND_OPS, ACTION_OPS } from '../services/functionRunner.js';
import { logEvent } from '../services/audit.js';

export const categoriesRouter = Router();
categoriesRouter.use(requireAuth);

const cfg = async () => (await Settings.load()).wmspanel;
const memberKey = (m) => `${m.serverId}:${m.kind}:${m.objId}`;
const pub = (c) => ({
  id: c.id, name: c.name, description: c.description, color: c.color,
  members: c.members.map(m => ({ ...m.toObject?.() ?? m, key: memberKey(m) })),
  updatedBy: c.updatedBy, updatedAt: c.updatedAt,
});

categoriesRouter.get('/', requirePerm('category.view'), async (_req, res) => {
  const items = await Category.find().sort({ name: 1 });
  res.json(items.map(pub));
});

// Live state for every member, batched per (server, kind) so one category costs
// a handful of calls rather than one per member.
categoriesRouter.get('/:id/state', requirePerm('category.view'), async (req, res) => {
  const cat = await Category.findById(req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });

  const servers = await NimbleServer.find();
  const byId = new Map(servers.map(s => [String(s._id), s]));
  const groups = new Map();
  for (const m of cat.members) {
    const k = `${m.serverId}|${m.kind}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }

  const c = await cfg();
  const state = {};
  await Promise.all([...groups.entries()].map(async ([k, members]) => {
    const [serverId, kind] = k.split('|');
    const sv = byId.get(serverId);
    const ops = KIND_OPS[kind];
    const mark = (patch) => members.forEach(m => { state[memberKey(m)] = patch; });
    if (!sv) return mark({ error: 'server missing from the panel' });
    if (!sv.wmspanelServerId) return mark({ error: 'server not mapped to WMSPanel' });
    if (!ops) return mark({ error: `unsupported kind ${kind}` });
    try {
      const data = await wmspanel[ops.get](c, sv.wmspanelServerId);
      const list = ops.pickList(data);
      for (const m of members) {
        const o = list.find(x => String(x.id) === String(m.objId));
        state[memberKey(m)] = o
          ? { found: true, paused: Boolean(o.paused), status: o.status || '', serverName: sv.name }
          : { found: false, serverName: sv.name };
      }
    } catch (e) { mark({ error: e.message, serverName: sv.name }); }
  }));
  res.json({ state });
});

categoriesRouter.use(requirePerm('category.manage'));

categoriesRouter.post('/', async (req, res) => {
  const { name, description, color } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const c = await Category.create({
      name: name.trim(), description: description || '', color: color || '',
      updatedBy: req.user.username,
    });
    logEvent({ req, action: 'category:create', target: c.name, outcome: 'ok', status: 201 });
    res.status(201).json(pub(c));
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'A category with this name already exists' });
    throw e;
  }
});

categoriesRouter.put('/:id', async (req, res) => {
  const c = await Category.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Category not found' });
  const { name, description, color } = req.body || {};
  if (name !== undefined) c.name = String(name).trim();
  if (description !== undefined) c.description = String(description);
  if (color !== undefined) c.color = String(color);
  c.updatedBy = req.user.username;
  await c.save();
  logEvent({ req, action: 'category:update', target: c.name, outcome: 'ok', status: 200 });
  res.json(pub(c));
});

categoriesRouter.delete('/:id', async (req, res) => {
  const c = await Category.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Category not found' });
  await c.deleteOne();
  logEvent({ req, action: 'category:delete', target: c.name, outcome: 'ok', status: 200 });
  res.json({ ok: true });
});

// Replace the whole membership list (the UI edits it as a set).
categoriesRouter.put('/:id/members', async (req, res) => {
  const c = await Category.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Category not found' });
  const seen = new Set();
  c.members = (Array.isArray(req.body?.members) ? req.body.members : [])
    .filter(m => m?.serverId && m?.kind && m?.objId)
    .filter(m => { const k = memberKey(m); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(m => ({ serverId: String(m.serverId), kind: String(m.kind), objId: String(m.objId), title: String(m.title || '') }));
  c.updatedBy = req.user.username;
  await c.save();
  logEvent({ req, action: 'category:members', target: `${c.name} (${c.members.length})`, outcome: 'ok', status: 200 });
  res.json(pub(c));
});

// Bulk start/stop/restart over selected members. Reuses the per-kind action
// rules from the Functions engine so behaviour cannot drift between the two.
// Restart is only offered where the API has an endpoint for it — the composite
// stop/hold/start belongs to Functions, where a run can be traced and rolled back.
categoriesRouter.post('/:id/action', async (req, res) => {
  const cat = await Category.findById(req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const action = String(req.body?.action || '');
  if (!['pause', 'resume', 'restart'].includes(action)) return res.status(400).json({ error: 'Unsupported action' });
  const keys = Array.isArray(req.body?.keys) && req.body.keys.length
    ? new Set(req.body.keys) : null;

  const servers = await NimbleServer.find();
  const byId = new Map(servers.map(s => [String(s._id), s]));
  const c = await cfg();
  const results = [];

  for (const m of cat.members) {
    const key = memberKey(m);
    if (keys && !keys.has(key)) continue;
    const r = { key, title: m.title, ok: false };
    const sv = byId.get(m.serverId);
    const ops = ACTION_OPS[m.kind];
    try {
      if (!sv?.wmspanelServerId) throw new Error('server is not mapped to WMSPanel');
      if (!ops) throw new Error(`actions are not supported for ${m.kind}`);
      const sid = sv.wmspanelServerId;
      if (action === 'restart') {
        if (!ops.restart || ops.restart === 'composite') {
          throw new Error('no restart endpoint for this kind — use a Function (stop/hold/start)');
        }
        if (ops.restart === 'endpoint') await wmspanel[ops.endpoint](c, sid, m.objId, 'restart');
        else await wmspanel[ops.restart](c, sid, m.objId);
      } else if (ops.pauseVia === 'endpoint') {
        await wmspanel[ops.endpoint](c, sid, m.objId, action);
      } else {
        await wmspanel[KIND_OPS[m.kind].put](c, sid, m.objId, { paused: action === 'pause' });
      }
      r.ok = true;
    } catch (e) { r.error = e.message; }
    results.push(r);
  }

  const okCount = results.filter(r => r.ok).length;
  logEvent({
    req, action: `category:${action}`,
    target: `${cat.name} (${okCount}/${results.length})`,
    outcome: okCount === results.length ? 'ok' : 'partial', status: 200,
  });
  res.json({ results, okCount, total: results.length });
});
