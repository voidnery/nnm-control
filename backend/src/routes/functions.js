import { Router } from 'express';
import { FunctionDef } from '../models/FunctionDef.js';
import { FunctionRun } from '../models/FunctionRun.js';
import { Role } from '../models/Role.js';
import { Settings } from '../models/Settings.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { requireAuth, requirePerm, hasPerm } from '../middleware/auth.js';
import { executeFunction, resolveVariant } from '../services/functionRunner.js';
import { logEvent } from '../services/audit.js';

// A rejected shape is the operator's problem to fix and must say what is wrong.
// Letting a mongoose ValidationError reach the async guard turned "this step
// has no server" into "Internal server error", which tells nobody anything.
function asBadRequest(e, res) {
  if (e?.name === 'ValidationError') {
    const first = Object.values(e.errors || {})[0];
    return res.status(400).json({ error: first?.message || e.message, field: first?.path || '' });
  }
  return null;
}
import { wmspanel } from '../services/wmspanelClient.js';

// iter11 2b — variants are stored data that decides what gets sent to a live
// broadcast server, so what can be stored is bounded here rather than trusted.
function cleanVariants(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.slice(0, 40).map((v, i) => {
    let id = String(v?.id || `v${i}`).slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, '') || `v${i}`;
    while (seen.has(id)) id = `${id}_`;      // two variants sharing an id would run the wrong one
    seen.add(id);
    const overrides = {};
    for (const [k, val] of Object.entries(v?.overrides || {})) {
      if (!/^\d+$/.test(k)) continue;        // keyed by step index, nothing else
      if (val && typeof val === 'object' && !Array.isArray(val)) overrides[k] = val;
    }
    return {
      id,
      name: String(v?.name || `Variant ${i + 1}`).slice(0, 80),
      description: String(v?.description || '').slice(0, 200),
      overrides,
    };
  });
}

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
  const { name, description = '', steps = [], variants = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  let fn;
  try {
    fn = await FunctionDef.create({ name, description, steps, variants: cleanVariants(variants), createdBy: req.user.username });
  } catch (e) { if (asBadRequest(e, res)) return; throw e; }
  res.status(201).json(fn);
});

functionsRouter.put('/:id', requirePerm('functions.manage'), async (req, res) => {
  const fn = await FunctionDef.findById(req.params.id);
  if (!fn) return res.status(404).json({ error: 'Not found' });
  const { name, description, steps, variants } = req.body || {};
  if (name !== undefined) fn.name = name;
  if (description !== undefined) fn.description = description;
  if (steps !== undefined) fn.steps = steps;
  if (variants !== undefined) fn.variants = cleanVariants(variants);
  try { await fn.save(); }
  catch (e) { if (asBadRequest(e, res)) return; throw e; }
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
    const run = await executeFunction(fn, req.user.username, String(req.body?.variantId || ''));
    res.status(201).json({ runId: run.id });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

// What will actually be sent, resolved by the SAME function the executor uses.
// A preview computed a second way would eventually disagree with the run, and
// the operator would be reading a reassurance rather than a fact.
functionsRouter.get('/:id/preview', requirePerm('functions.execute'), async (req, res) => {
  const fn = await FunctionDef.findById(req.params.id);
  if (!fn) return res.status(404).json({ error: 'Not found' });
  try {
    const { steps, variant } = resolveVariant(fn, String(req.query.variantId || ''));
    res.json({
      variant,
      steps: steps.map((st, i) => ({
        index: i,
        label: st.label || '',
        type: st.type,
        objectKind: st.objectKind || '',
        targetLabel: st.targetLabel || '',
        patch: st.patch || {},
        overridden: Object.keys(
          (fn.variants.find(v => v.id === req.query.variantId)?.overrides || {})[String(i)] || {},
        ),
      })),
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// The run history is a log, not a record: it grows for ever and the interesting
// part is the last few days. Deleting is explicit and bounded — a minimum age
// is enforced here rather than trusted from the request, so a mistyped zero
// cannot wipe the trace of what happened this morning.
functionsRouter.delete('/runs', requirePerm('functions.execute'), async (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.olderThanDays) || 3));
  const before = new Date(Date.now() - days * 86400_000);
  const r = await FunctionRun.deleteMany({ startedAt: { $lt: before }, status: { $ne: 'running' } });
  logEvent({
    req, action: 'functions:prune-runs',
    target: `${r.deletedCount || 0} run(s) older than ${days}d`, outcome: 'ok', status: 200,
  });
  res.json({ deleted: r.deletedCount || 0, olderThanDays: days, before });
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

// App/stream picker source: active streams via WMSPanel Streams API (needs
// Deep stats enabled); falls back to aggregating app/stream pairs from
// configured republish/outgoing/udp objects.
functionsRouter.get('/streams/:serverId', requirePerm('functions.manage'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.serverId);
  if (!server?.wmspanelServerId) return res.status(409).json({ error: 'Server is not mapped to WMSPanel' });
  const settings = await Settings.load();
  const cfg = settings.wmspanel;
  const sid = server.wmspanelServerId;
  let streams = [];
  let source = 'aggregated';
  try {
    const d = await wmspanel.liveStreams(cfg, sid);
    streams = (d.streams || [])
      .filter(x => x.application)
      .map(x => ({ app: x.application, stream: x.stream || '' }));
    if (streams.length) source = 'live-streams';
  } catch { /* fall back below */ }
  if (streams.length === 0) {
    const pairs = new Map();
    const add = (a, st) => { if (a) pairs.set(`${a}/${st || ''}`, { app: a, stream: st || '' }); };
    // Canonical field names pinned from the live account dump (2026-07-21):
    // republish: src_app/src_strm; outgoing: application/stream;
    // udp: source_streams[] of {application, stream, *_pid}
    try { const d = await wmspanel.republishList(cfg, sid); (d.rules || []).forEach(r => add(r.src_app, r.src_strm)); } catch {}
    try { const d = await wmspanel.outgoingList(cfg, sid); (d.streams || []).forEach(o => add(o.application, o.stream)); } catch {}
    try { const d = await wmspanel.udpList(cfg, sid); (d.settings || []).forEach(o => (o.source_streams || []).forEach(ss => add(ss.application, ss.stream))); } catch {}
    streams = [...pairs.values()];
  }
  streams.sort((a, b) => (a.app + '/' + a.stream).localeCompare(b.app + '/' + b.stream));
  res.json({ streams, source });
});

// Object browser for the builder: list WMSPanel objects of a kind on a server.
functionsRouter.get('/objects/:serverId/:kind', requirePerm('functions.manage'), async (req, res) => {
  // transcoders are account-level: serverId is ignored (frontend passes 'any')
  const ACCOUNT_BROWSE = {
    transcoder: async (c) => (await wmspanel.transcoderList(c)).transcoders || [],
    abr: async (c) => (await wmspanel.abrList(c)).settings || [],
    alias: async (c) => (await wmspanel.aliasList(c)).settings || [],
  };
  if (ACCOUNT_BROWSE[req.params.kind]) {
    const settings0 = await Settings.load();
    try {
      return res.json({ objects: await ACCOUNT_BROWSE[req.params.kind](settings0.wmspanel) });
    } catch (e) {
      return res.status(502).json({ error: e.message, upstream: e.data ?? null });
    }
  }
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
    else if (kind === 'live_pull') { data = await wmspanel.livePullList(cfg, sid); data = data.settings || []; }
    // SRT In / MPEG-TS In — the sources an outgoing stream points at. Missing
    // here for as long as the steps that need it have existed.
    else if (kind === 'incoming') { data = await wmspanel.incomingList(cfg, sid); data = data.streams || data.settings || []; }
    else return res.status(400).json({ error: `Unknown kind "${kind}"` });
    res.json({ objects: data });
  } catch (e) {
    res.status(502).json({ error: e.message, upstream: e.data ?? null });
  }
});
