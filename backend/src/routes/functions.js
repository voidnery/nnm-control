import { Router } from 'express';
import { FunctionDef } from '../models/FunctionDef.js';
import { FunctionRun } from '../models/FunctionRun.js';
import { Role } from '../models/Role.js';
import { Settings } from '../models/Settings.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { requireAuth, requirePerm, hasPerm } from '../middleware/auth.js';
import { executeFunction } from '../services/functionRunner.js';
import { wmspanel } from '../services/wmspanelClient.js';

export const functionsRouter = Router();
functionsRouter.use(requireAuth);

// List: visible to managers, executors and role managers (for assignment UI).
functionsRouter.get('/', async (req, res) => {
  const allowed = ['functions.manage', 'functions.execute', 'roles.manage'].some(p => hasPerm(req.perms, p));
  if (!allowed) return res.status(403).json({ error: 'Missing permission' });
  const fns = await FunctionDef.find().sort({ name: 1 });
  res.json(fns);
});

functionsRouter.post('/', requirePerm('functions.manage'), async (req, res) => {
  const { name, description = '', steps = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const fn = await FunctionDef.create({ name, description, steps, createdBy: req.user.username });
  res.status(201).json(fn);
});

functionsRouter.put('/:id', requirePerm('functions.manage'), async (req, res) => {
  const fn = await FunctionDef.findById(req.params.id);
  if (!fn) return res.status(404).json({ error: 'Not found' });
  const { name, description, steps } = req.body || {};
  if (name !== undefined) fn.name = name;
  if (description !== undefined) fn.description = description;
  if (steps !== undefined) fn.steps = steps;
  await fn.save();
  res.json(fn);
});

functionsRouter.delete('/:id', requirePerm('functions.manage'), async (req, res) => {
  const fn = await FunctionDef.findByIdAndDelete(req.params.id);
  if (!fn) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Execute: needs functions.execute; custom roles additionally need the
// specific function assigned in their role.
functionsRouter.post('/:id/run', requirePerm('functions.execute'), async (req, res) => {
  const fn = await FunctionDef.findById(req.params.id);
  if (!fn) return res.status(404).json({ error: 'Not found' });
  if (req.user.roleType === 'custom') {
    const role = await Role.findById(req.user.roleId).lean();
    const allowed = (role?.functionIds || []).some(id => String(id) === String(fn._id));
    if (!allowed) return res.status(403).json({ error: 'This function is not assigned to your role' });
  }
  try {
    const run = await executeFunction(fn, req.user.username);
    res.status(201).json({ runId: run.id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

functionsRouter.get('/runs', requirePerm('functions.execute'), async (_req, res) => {
  const runs = await FunctionRun.find().sort({ startedAt: -1 }).limit(50);
  res.json(runs);
});

functionsRouter.get('/runs/:id', requirePerm('functions.execute'), async (req, res) => {
  const run = await FunctionRun.findById(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.json(run);
});

// Object browser for the builder: list WMSPanel objects of a kind on a server.
functionsRouter.get('/objects/:serverId/:kind', requirePerm('functions.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.serverId);
  if (!server?.wmspanelServerId) return res.status(409).json({ error: 'Server is not mapped to WMSPanel' });
  const settings = await Settings.load();
  const cfg = settings.wmspanel;
  const sid = server.wmspanelServerId;
  const kind = req.params.kind;
  try {
    let data;
    if (kind === 'republish') { data = await wmspanel.republishList(cfg, sid); data = data.rules || data.republish_rules || []; }
    else if (kind === 'udp') { data = await wmspanel.udpList(cfg, sid); data = data.settings || []; }
    else if (kind === 'outgoing') { data = await wmspanel.outgoingList(cfg, sid); data = data.streams || data.settings || []; }
    else if (kind === 'hotswap') { data = await wmspanel.hotswapList(cfg, sid); data = data.settings || []; }
    else return res.status(400).json({ error: 'Unknown kind' });
    res.json({ objects: data });
  } catch (e) {
    res.status(502).json({ error: e.message, upstream: e.data ?? null });
  }
});
