import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { Settings } from '../models/Settings.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { StatSample } from '../models/StatSample.js';
import { TranscoderCache } from '../models/TranscoderCache.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { logEvent } from '../services/audit.js';

export const transcoderFleetRouter = Router();
transcoderFleetRouter.use(requireAuth);

const cfg = async () => (await Settings.load()).wmspanel;
const pathsOf = (pipelines, side) => [...new Set(
  pipelines.flatMap(p => (p[side] || [])
    .filter(io => io.app && io.stream)
    .map(io => `${io.app}/${io.stream}`)),
)];

// Health of one scenario, from its own outputs: an operator cares whether the
// thing is actually pushing bytes, not whether the config says "running".
export function classifyHealth({ paused, outputs = [], flowing = 0, hasMetrics = true, known = true }) {
  if (!known || !hasMetrics || outputs.length === 0) return 'unknown';
  if (paused) return 'paused';
  if (flowing === 0) return 'silent';          // says running, nothing coming out
  return flowing < outputs.length ? 'partial' : 'ok';
}

// Everything, on one screen: one API call for the list, cached scenario shape,
// and health derived from the metrics the panel already collects.
transcoderFleetRouter.get('/fleet', requirePerm('wmsobjects.view'), async (req, res) => {
  try {
    const c = await cfg();
    const [list, licenses, servers, cached] = await Promise.all([
      wmspanel.transcoderList(c),
      wmspanel.transcoderLicenses(c).catch(() => ({})),
      NimbleServer.find(),
      TranscoderCache.find(),
    ]);

    const byWms = new Map(servers.filter(s => s.wmspanelServerId).map(s => [s.wmspanelServerId, s]));
    const cacheById = new Map(cached.map(c2 => [c2.transcoderId, c2]));
    const transcoders = list.transcoders || list.transcoder || [];

    // One metrics query for every output we know about, across all servers.
    const wanted = [];
    for (const t of transcoders) {
      const cc = cacheById.get(t.id);
      const sv = byWms.get(t.server_id);
      if (!cc || !sv) continue;
      for (const p of cc.outputs) wanted.push({ serverId: String(sv._id), subject: `stream:${p}` });
    }
    const live = new Map();
    if (wanted.length) {
      const since = new Date(Date.now() - 5 * 60 * 1000);
      const rows = await StatSample.aggregate([
        { $match: { $or: wanted.map(w => ({ serverId: w.serverId, subject: w.subject })), ts: { $gte: since } } },
        { $sort: { ts: -1 } },
        { $group: { _id: { s: '$serverId', j: '$subject' }, ts: { $first: '$ts' }, metrics: { $first: '$metrics' } } },
      ]);
      for (const r of rows) {
        const m = r.metrics instanceof Map ? Object.fromEntries(r.metrics) : (r.metrics || {});
        live.set(`${r._id.s}|${r._id.j}`, { ts: r.ts, bandwidth: m.bandwidth ?? null });
      }
    }

    const items = transcoders.map(t => {
      const cc = cacheById.get(t.id);
      const sv = byWms.get(t.server_id);
      let flowing = 0;
      const outputs = cc?.outputs || [];
      if (cc && sv) {
        for (const p of outputs) {
          const v = live.get(`${String(sv._id)}|stream:${p}`);
          if (v && v.bandwidth > 0) flowing++;
        }
      }
      const health = classifyHealth({
        paused: Boolean(t.paused), outputs, flowing,
        hasMetrics: live.size > 0, known: Boolean(cc && sv),
      });
      const total = outputs.length;
      return {
        id: t.id, name: t.name, description: t.description || '',
        paused: Boolean(t.paused), tags: t.tags || [],
        wmspanelServerId: t.server_id || '',
        serverName: sv ? sv.name : '', panelServerId: sv ? String(sv._id) : null,
        videoCount: cc?.videoCount ?? null, audioCount: cc?.audioCount ?? null,
        outputs: cc?.outputs || [], detailsAt: cc?.fetchedAt || null,
        health, flowing, total,
      };
    });

    res.json({ items, licenses: licenses.licenses || licenses.transcoder_licenses || [] });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// Refresh cached scenario shape. Costs one API call per transcoder, so the
// caller is told upfront and can narrow it to a selection.
transcoderFleetRouter.post('/fleet/refresh', requirePerm('wmsobjects.view'), async (req, res) => {
  try {
    const c = await cfg();
    const ids = Array.isArray(req.body?.ids) && req.body.ids.length ? req.body.ids : null;
    const list = await wmspanel.transcoderList(c);
    const all = list.transcoders || list.transcoder || [];
    const targets = ids ? all.filter(t => ids.includes(t.id)) : all;

    const servers = await NimbleServer.find();
    const byWms = new Map(servers.filter(s => s.wmspanelServerId).map(s => [s.wmspanelServerId, s]));

    const results = [];
    for (const t of targets) {
      try {
        const d = await wmspanel.transcoderGet(c, t.id);
        const tr = d.transcoder || d;
        const video = tr.video_pipelines || [];
        const audio = tr.audio_pipelines || [];
        const sv = byWms.get(tr.server_id);
        await TranscoderCache.findOneAndUpdate(
          { transcoderId: t.id },
          { $set: {
            name: tr.name || t.name, wmspanelServerId: tr.server_id || '',
            panelServerId: sv ? String(sv._id) : '',
            videoCount: video.length, audioCount: audio.length,
            inputs: pathsOf([...video, ...audio], 'inputs'),
            outputs: pathsOf([...video, ...audio], 'outputs'),
            fetchedAt: new Date(),
          } },
          { upsert: true },
        );
        results.push({ id: t.id, ok: true, video: video.length, audio: audio.length });
      } catch (e) {
        results.push({ id: t.id, ok: false, error: e.message });
      }
    }
    logEvent({ req, action: 'transcoder:fleet_refresh', target: `${results.length} scenario(s)`, outcome: 'ok', status: 200 });
    res.json({ results, apiCalls: targets.length + 1 });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// Bulk pause/resume. Restart is deliberately absent: transcoders have no restart
// endpoint, so it would mean pause + hold + resume per scenario — minutes of
// dead air done en masse with no trace. That belongs in Functions, where a run
// is stepped, logged and reversible.
transcoderFleetRouter.post('/fleet/action', requirePerm('wmsobjects.manage'), async (req, res) => {
  const action = String(req.body?.action || '');
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!['pause', 'resume'].includes(action)) return res.status(400).json({ error: 'Unsupported action' });
  if (!ids.length) return res.status(400).json({ error: 'No transcoders selected' });

  const c = await cfg();
  const results = [];
  for (const id of ids) {
    try {
      await (action === 'pause' ? wmspanel.transcoderPause(c, id) : wmspanel.transcoderResume(c, id));
      results.push({ id, ok: true });
    } catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  const okCount = results.filter(r => r.ok).length;
  logEvent({ req, action: `transcoder:bulk_${action}`, target: `${okCount}/${ids.length}`,
             outcome: okCount === ids.length ? 'ok' : 'partial', status: 200 });
  res.json({ results, okCount, total: ids.length });
});
