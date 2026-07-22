import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { Settings } from '../models/Settings.js';
import { logEvent } from '../services/audit.js';

export const copyStreamsRouter = Router();
copyStreamsRouter.use(requireAuth);

const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
};

// Per-kind copy spec. body() extracts ONLY portable fields (nothing that
// references a server-local object id). sourceWarn() flags linkage that cannot
// cross servers. paused:'field' → object has a paused boolean; 'action' →
// separate pause endpoint.
const KIND = {
  udp: {
    list: 'udpList', create: 'udpCreate', update: 'udpUpdate', paused: 'field',
    body: (o) => pick(o, ['name', 'description', 'protocol', 'ip', 'port', 'ttl', 'parameters']),
    sourceWarn: (o) => (o.source_id ? 'source_id is server-specific and was not copied — set the source on the target' : null),
    postCreate: (o) => (Array.isArray(o.source_streams) && o.source_streams.length
      ? { source_streams: o.source_streams } : null),
  },
  outgoing: {
    list: 'outgoingList', create: 'outgoingCreate', action: 'outgoingAction', paused: 'action',
    body: (o) => pick(o, ['application', 'stream', 'description']),
    sourceWarn: (o) => ((o.video_source || o.audio_source) ? 'video/audio source references are server-specific and were not copied — re-link sources on the target' : null),
  },
  livepull: {
    list: 'livePullList', create: 'livePullCreate', update: 'livePullUpdate', paused: 'field',
    body: (o) => ({ url: o.url, fallback_urls: o.fallback_urls || [], application: o.application, stream: o.stream, description: o.description || '' }),
  },
  incoming: {
    list: 'incomingList', create: 'incomingCreate', update: 'incomingUpdate', paused: 'field',
    body: (o) => pick(o, ['name', 'description', 'protocol', 'ip', 'port', 'receive_mode', 'parameters']),
  },
};

// Pull an object id out of a create response of unknown shape.
function findId(resp) {
  if (!resp || typeof resp !== 'object') return null;
  if (typeof resp.id === 'string') return resp.id;
  for (const v of Object.values(resp)) {
    if (v && typeof v === 'object' && typeof v.id === 'string') return v.id;
  }
  return null;
}

async function resolveMapped(id) {
  const sv = await NimbleServer.findById(id);
  if (!sv) return { error: `Server ${id} not found` };
  if (!sv.wmspanelServerId) return { error: `Server "${sv.name}" is not mapped to a WMSPanel id` };
  return { sv };
}

// POST /api/wmspanel/copy-streams
// body: { sourceServerId, targetServerId, kind, ids: [], startPaused: true }
copyStreamsRouter.post('/copy-streams', requirePerm('wmsobjects.manage'), async (req, res) => {
  const { sourceServerId, targetServerId, kind, ids, startPaused = true } = req.body || {};
  const spec = KIND[kind];
  if (!spec) return res.status(400).json({ error: `Unsupported kind "${kind}"` });
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No stream ids provided' });
  if (sourceServerId === targetServerId) return res.status(400).json({ error: 'Source and target servers are the same' });

  const src = await resolveMapped(sourceServerId);
  if (src.error) return res.status(409).json({ error: src.error });
  const dst = await resolveMapped(targetServerId);
  if (dst.error) return res.status(409).json({ error: dst.error });

  const settings = await Settings.load();
  const cfg = settings.wmspanel;
  const srcSid = src.sv.wmspanelServerId;
  const dstSid = dst.sv.wmspanelServerId;

  // Authoritative source objects (don't trust client payloads).
  let sourceList;
  try {
    const data = await wmspanel[spec.list](cfg, srcSid);
    sourceList = data.settings || data.streams || data.rules || data.objects || [];
  } catch (e) {
    return res.status(502).json({ error: `Failed to list source ${kind}: ${e.message}` });
  }
  const byId = new Map(sourceList.map(o => [String(o.id), o]));

  const results = [];
  for (const id of ids) {
    const o = byId.get(String(id));
    const r = { sourceId: id, ok: false, warnings: [] };
    if (!o) { r.error = 'not found on source'; results.push(r); continue; }
    try {
      const body = spec.body(o);
      if (spec.paused === 'field' && startPaused) body.paused = true;
      const created = await wmspanel[spec.create](cfg, dstSid, body);
      const newId = findId(created);
      r.targetId = newId;

      const warn = spec.sourceWarn?.(o);
      if (warn) r.warnings.push(warn);

      // Copy portable secondary payload (e.g. udp source_streams).
      if (spec.postCreate && newId && spec.update) {
        const extra = spec.postCreate(o);
        if (extra) {
          try { await wmspanel[spec.update](cfg, dstSid, newId, extra); }
          catch (e) { r.warnings.push(`secondary update failed: ${e.message}`); }
        }
      }

      // Ensure stopped on target.
      if (startPaused && newId) {
        try {
          if (spec.paused === 'action') await wmspanel[spec.action](cfg, dstSid, newId, 'pause');
          else if (spec.update) await wmspanel[spec.update](cfg, dstSid, newId, { paused: true });
        } catch (e) { r.warnings.push(`could not confirm paused state: ${e.message}`); }
      } else if (startPaused && !newId) {
        r.warnings.push('created, but target id unknown — verify it is paused');
      }

      r.ok = true;
    } catch (e) {
      r.error = e.message;
    }
    results.push(r);
  }

  const okCount = results.filter(r => r.ok).length;
  logEvent({
    req, action: 'streams:copy',
    target: `${kind} ${src.sv.name}→${dst.sv.name} (${okCount}/${ids.length})`,
    outcome: okCount === ids.length ? 'ok' : 'partial', status: 200,
  });
  res.json({ results, okCount, total: ids.length });
});
