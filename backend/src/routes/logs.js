import { Router } from 'express';
import { NimbleServer } from '../models/NimbleServer.js';
import { Settings } from '../models/Settings.js';
import { LogRecord, LogCursor, LOG_CAP_MB } from '../models/LogRecord.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { runTask } from '../services/agentBus.js';
import { collectorState } from '../services/logCollector.js';
import { searchLogs, groupLogs, logFacets, templateOf, categoryCounts, CATEGORIES } from '../services/logQuery.js';
import { logEvent } from '../services/audit.js';

// iter10 m1 — transport only. This exposes enough to prove the pipe works and
// to diagnose it; the searchable views, categories and dashboards are m3-m5
// and will query the same collection.
export const logsRouter = Router();
logsRouter.use(requireAuth);

// What the collector is doing, per server and file. The counters here are the
// first thing to look at when a tail looks wrong: bytesMissed > 0 means a
// rotation outran us, lastError means the agent said no.
logsRouter.get('/status', requirePerm('streams.view'), async (req, res) => {
  const s = await Settings.load();
  const [cursors, servers, total] = await Promise.all([
    LogCursor.find().lean(),
    NimbleServer.find({ 'agent.enabled': true }, { name: 1 }).lean(),
    LogRecord.estimatedDocumentCount(),
  ]);
  const byId = new Map(servers.map(x => [String(x._id), x.name]));
  res.json({
    settings: s.logs,
    collector: collectorState(),
    capMb: LOG_CAP_MB,
    storedRecords: total,
    agentServers: servers.length,
    cursors: cursors.map(c => ({
      serverId: String(c.serverId),
      serverName: byId.get(String(c.serverId)) || '(server removed)',
      file: c.file,
      offset: c.offset,
      gen: c.gen,
      lastAt: c.lastAt,
      lastError: c.lastError,
      bytesRead: c.bytesRead,
      recordsStored: c.recordsStored,
      rotations: c.rotations,
      bytesMissed: c.bytesMissed,
      pending: Boolean(c.pending),
    })),
  });
});

// Which log files a server actually has. Used when configuring which to
// follow, and as a direct agent reachability check.
logsRouter.get('/servers/:id/files', requirePerm('streams.view'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  try {
    res.json(await runTask(server, 'GET /logs', { createdBy: req.user?.username }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// Most recent records. Ordering is by offset within a generation, never by
// timestamp: Nimble's stamps have one-second resolution and it emits ~98
// lines/s, so a hundred records routinely share one stamp.
logsRouter.get('/tail', requirePerm('streams.view'), async (req, res) => {
  const q = {};
  if (req.query.serverId) q.serverId = req.query.serverId;
  if (req.query.file) q.file = req.query.file;
  if (req.query.level) q.level = { $in: String(req.query.level).split(',') };
  if (req.query.sub) q.sub = { $in: String(req.query.sub).split(',') };
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const records = await LogRecord.find(q).sort({ gen: -1, offset: -1 }).limit(limit).lean();
  res.json({ records: records.reverse(), limit });
});

// iter10 m3 — the general warehouse: every record, with the filters needed to
// find something in ~14 GB/day.
//
// Grouped by default. On the measured data an ungrouped view is one line
// repeated eight times a second, and the operator opened this during an
// incident, not for entertainment.
const readQuery = (req) => ({
  serverId: req.query.serverId || undefined,
  file: req.query.file || undefined,
  levels: req.query.levels ? String(req.query.levels).split(',').filter(Boolean) : undefined,
  subs: req.query.subs ? String(req.query.subs).split(',').filter(Boolean) : undefined,
  from: req.query.from || undefined,
  to: req.query.to || undefined,
  q: req.query.q || undefined,
  category: req.query.category || undefined,
  tag: req.query.tag || undefined,
  pid: req.query.pid || undefined,
  limit: req.query.limit,
  before: req.query.before,
});

logsRouter.get('/search', requirePerm('streams.view'), async (req, res) => {
  try { res.json(await searchLogs(readQuery(req))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

logsRouter.get('/groups', requirePerm('streams.view'), async (req, res) => {
  try { res.json(await groupLogs(readQuery(req))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// iter10 m4 — the functional windows: how much each part of Nimble is saying,
// and how much of that is bad.
logsRouter.get('/categories', requirePerm('streams.view'), async (req, res) => {
  try {
    res.json({ definitions: CATEGORIES, counts: await categoryCounts(readQuery(req)) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

logsRouter.get('/facets', requirePerm('streams.view'), async (req, res) => {
  try { res.json(await logFacets(readQuery(req))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// The records behind one group. The template is not stored, so the rows are
// matched by re-templating within the same subsystem and level — the same
// function that produced the group, which is what keeps the two consistent.
logsRouter.get('/groups/rows', requirePerm('streams.view'), async (req, res) => {
  const template = String(req.query.template || '');
  if (!template) return res.status(400).json({ error: 'template is required' });
  try {
    const { rows } = await searchLogs({ ...readQuery(req), limit: 500 });
    const want = rows.filter(r => templateOf(r.msg) === template).slice(0, Number(req.query.limit) || 100);
    res.json({ rows: want, scanned: rows.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Start/stop without a container restart, mirroring how the stats collector
// is controlled.
logsRouter.post('/collector', requirePerm('settings.manage'), async (req, res) => {
  const on = Boolean(req.body?.enabled);
  const s = await Settings.load();
  s.logs.enabled = on;
  if (req.body?.intervalSec) s.logs.intervalSec = Math.max(2, Number(req.body.intervalSec));
  if (Array.isArray(req.body?.files) && req.body.files.length) s.logs.files = req.body.files;
  await s.save();
  // iter12 m2 — nothing to start or stop here any more. Agents learn the new
  // setting on their next poll, within seconds, and begin or stop shipping.
  logEvent({ req, action: 'logs:collector', target: on ? 'start' : 'stop', outcome: 'ok', status: 200 });
  res.json({ ok: true, settings: s.logs, collector: collectorState() });
});
