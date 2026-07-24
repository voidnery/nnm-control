import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { Settings } from '../models/Settings.js';
import { StatSample } from '../models/StatSample.js';
import { wmspanel } from '../services/wmspanelClient.js';

export const transcoderGraphRouter = Router();
transcoderGraphRouter.use(requireAuth);

// A scenario as the operator thinks of it: per pipeline, input -> filters ->
// outputs, plus what each of those app/stream endpoints is actually doing right
// now. The live part is what WMSPanel's own scenario view does not show.
transcoderGraphRouter.get('/transcoders/:id/graph', requirePerm('wmsobjects.view'), async (req, res) => {
  try {
    const cfg = (await Settings.load()).wmspanel;
    const data = await wmspanel.transcoderGet(cfg, req.params.id);
    const tr = data.transcoder || data;

    // Transcoders are account-level and carry a WMSPanel server id; metrics are
    // keyed by our own server id, so the two have to be bridged.
    const server = tr.server_id ? await NimbleServer.findOne({ wmspanelServerId: tr.server_id }) : null;

    const refs = new Set();
    for (const kind of ['video_pipelines', 'audio_pipelines']) {
      for (const p of tr[kind] || []) {
        for (const io of [...(p.inputs || []), ...(p.outputs || [])]) {
          if (io.app && io.stream) refs.add(`${io.app}/${io.stream}`);
        }
      }
    }

    // Latest sample per referenced stream, from the collector's own store.
    const live = {};
    if (server && refs.size) {
      const subjects = [...refs].map(r => `stream:${r}`);
      const since = new Date(Date.now() - 5 * 60 * 1000);
      const rows = await StatSample.aggregate([
        { $match: { serverId: String(server._id), subject: { $in: subjects }, ts: { $gte: since } } },
        { $sort: { ts: -1 } },
        { $group: { _id: '$subject', ts: { $first: '$ts' }, metrics: { $first: '$metrics' } } },
      ]);
      for (const r of rows) {
        const key = r._id.replace(/^stream:/, '');
        const m = r.metrics instanceof Map ? Object.fromEntries(r.metrics) : (r.metrics || {});
        live[key] = { ts: r.ts, bandwidth: m.bandwidth ?? null };
      }
    }

    res.json({
      transcoder: {
        id: tr.id, name: tr.name, description: tr.description || '',
        paused: Boolean(tr.paused), serverId: tr.server_id || '', tags: tr.tags || [],
      },
      panelServerId: server ? String(server._id) : null,
      panelServerName: server ? server.name : null,
      // No metrics without a mapped server or without collection running — say so
      // rather than rendering an all-grey graph that looks like an outage.
      liveAvailable: Boolean(server) && Object.keys(live).length > 0,
      video: tr.video_pipelines || [],
      audio: tr.audio_pipelines || [],
      live,
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});
