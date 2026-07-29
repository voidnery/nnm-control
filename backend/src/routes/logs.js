import { Router } from 'express';
import { NimbleServer } from '../models/NimbleServer.js';
import { Settings } from '../models/Settings.js';
import { LogRecord, LogCursor, LOG_CAP_MB } from '../models/LogRecord.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { agent } from '../services/agentClient.js';
import { collectorState, collectOnce, ingestFile, startLogCollector, stopLogCollector } from '../services/logCollector.js';
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
    res.json(await agent.logsList(server));
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

// Manual pull, for setting up and for proving a change took effect without
// waiting for the next tick.
logsRouter.post('/ingest', requirePerm('servers.manage'), async (req, res) => {
  try {
    if (req.body?.serverId) {
      const server = await NimbleServer.findById(req.body.serverId);
      if (!server) return res.status(404).json({ error: 'Not found' });
      const s = await Settings.load();
      const files = s.logs?.files?.length ? s.logs.files : ['nimble.log'];
      const results = [];
      for (const f of files) results.push(await ingestFile(server, f));
      logEvent({ req, action: 'logs:ingest', target: server.name, outcome: 'ok', status: 200 });
      return res.json({ results });
    }
    const out = await collectOnce();
    logEvent({ req, action: 'logs:ingest', target: 'all servers', outcome: 'ok', status: 200 });
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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
  if (on) await startLogCollector(); else stopLogCollector();
  logEvent({ req, action: 'logs:collector', target: on ? 'start' : 'stop', outcome: 'ok', status: 200 });
  res.json({ ok: true, settings: s.logs, collector: collectorState() });
});
