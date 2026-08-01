import { Router } from 'express';
import { NimbleServer } from '../models/NimbleServer.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { nimble } from '../services/nimbleClient.js';
import { Settings } from '../models/Settings.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { joinLive, liveSummary } from '../services/streamJoin.js';

// Nimble returns its stats under a different key per endpoint, and an array
// directly on some builds. Same tolerance the collector already uses.
const asList = (d) => {
  for (const k of ['streams', 'sockets', 'stats', 'rules']) if (Array.isArray(d?.[k])) return d[k];
  return Array.isArray(d) ? d : [];
};

// Permission-gated proxy of Nimble native API per managed server.
export const nimbleRouter = Router();
nimbleRouter.use(requireAuth);

// Hard gate: while the control plane is WMSPanel API, the native API is fully
// disabled — no calls leave the panel through this router.
nimbleRouter.use(async (_req, res, next) => {
  const s = await Settings.load();
  if (s.controlPlane === 'wmspanel') {
    return res.status(409).json({ error: 'Native Nimble API is disabled: control plane is WMSPanel API (see Settings)' });
  }
  next();
});

async function loadServer(req, res, next) {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  req.nimbleServer = server;
  next();
}

function proxy(fn) {
  return async (req, res) => {
    try {
      const data = await fn(req);
      res.json(data ?? { status: 'Ok' });
    } catch (e) {
      // 502: upstream Nimble unreachable / errored — distinct from panel errors.
      res.status(502).json({ error: `Nimble API error: ${e.message}`, upstream: e.data ?? null });
    }
  };
}

const r = nimbleRouter;
r.get('/:id/status',           requirePerm('servers.view'),    loadServer, proxy(rq => nimble.serverStatus(rq.nimbleServer)));
r.get('/:id/streams',          requirePerm('streams.view'),    loadServer, proxy(rq => nimble.liveStreams(rq.nimbleServer)));
r.get('/:id/rtmp/settings',    requirePerm('streams.view'),    loadServer, proxy(rq => nimble.rtmpSettings(rq.nimbleServer)));
r.get('/:id/sessions',         requirePerm('sessions.view'),   loadServer, proxy(rq => nimble.sessions(rq.nimbleServer)));
r.post('/:id/sessions/delete', requirePerm('sessions.manage'), loadServer, proxy(rq => nimble.deleteSessions(rq.nimbleServer, rq.body?.ids || [])));
r.get('/:id/srt',              requirePerm('srt.view'),        loadServer, proxy(async rq => {
  // Consolidated SRT view: both directions in one call.
  const s = rq.nimbleServer;
  const [sender, receiver] = await Promise.allSettled([nimble.srtSenderStats(s), nimble.srtReceiverStats(s)]);
  return {
    sender:   sender.status === 'fulfilled' ? sender.value : { error: sender.reason?.message },
    receiver: receiver.status === 'fulfilled' ? receiver.value : { error: receiver.reason?.message },
  };
}));
r.get('/:id/republish',        requirePerm('republish.view'),   loadServer, proxy(rq => nimble.republishRules(rq.nimbleServer)));
r.get('/:id/republish/stats',  requirePerm('republish.view'),   loadServer, proxy(rq => nimble.republishStats(rq.nimbleServer)));
r.post('/:id/republish',       requirePerm('republish.manage'), loadServer, proxy(rq => nimble.republishCreate(rq.nimbleServer, rq.body || {})));
r.delete('/:id/republish/:ruleId', requirePerm('republish.manage'), loadServer, proxy(rq => nimble.republishDelete(rq.nimbleServer, rq.params.ruleId)));
r.get('/:id/mpegts/status',    requirePerm('mpegts.view'),      loadServer, proxy(rq => nimble.mpegtsStatus(rq.nimbleServer)));
r.get('/:id/mpegts/settings',  requirePerm('mpegts.view'),      loadServer, proxy(rq => nimble.mpegtsSettings(rq.nimbleServer)));
r.get('/:id/playlist',         requirePerm('playlist.view'),    loadServer, proxy(rq => nimble.playlistStatus(rq.nimbleServer)));
r.post('/:id/control/reload-config', requirePerm('control.manage'), loadServer, proxy(rq => nimble.reloadConfig(rq.nimbleServer)));
r.post('/:id/control/reload-ssl',    requirePerm('control.manage'), loadServer, proxy(rq => nimble.reloadSsl(rq.nimbleServer)));
r.post('/:id/control/sync-panel',    requirePerm('control.manage'), loadServer, proxy(rq => nimble.syncPanel(rq.nimbleServer)));

// iter16 m1 — live values for the objects WMSPanel holds.
//
// The stats come from Nimble's native API, which the panel already polls for
// its charts; what was missing was the pairing. Both halves are fetched here so
// the join happens once, server-side, instead of every table row guessing.
nimbleRouter.get('/:id/live-objects/:kind', requirePerm('wmsobjects.view'), async (req, res) => {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const kind = String(req.params.kind);

  const SOURCES = {
    incoming: { native: 'srtReceiverStats', wms: 'incomingList', pick: (d) => d.streams || d.settings || [] },
    outgoing: { native: 'srtSenderStats', wms: 'outgoingList', pick: (d) => d.streams || d.settings || [] },
    republish: { native: 'republishStats', wms: 'republishList', pick: (d) => d.rules || d.republish_rules || [] },
  };
  const src = SOURCES[kind];
  if (!src) return res.status(400).json({ error: `unknown kind "${kind}"` });

  const settings = await Settings.load();
  // Independent on purpose: native stats are worth having even when WMSPanel
  // is unreachable, and the object list is worth having when a server is.
  const [nativeRes, wmsRes] = await Promise.allSettled([
    nimble[src.native](server),
    wmspanel[src.wms](settings.wmspanel, server.wmspanelServerId),
  ]);

  if (nativeRes.status !== 'fulfilled') {
    return res.json({
      kind, available: false,
      reason: String(nativeRes.reason?.message || nativeRes.reason).slice(0, 200),
    });
  }

  const entries = asList(nativeRes.value);
  const objects = wmsRes.status === 'fulfilled' ? src.pick(wmsRes.value) : [];
  const joined = joinLive(entries, objects);

  res.json({
    kind,
    available: true,
    strategy: joined.strategy,
    matched: joined.matched,
    objects: objects.length,
    entries: entries.length,
    live: Object.fromEntries(Object.entries(joined.byObjectId).map(([id, e]) => [id, liveSummary(e)])),
    // Returned so a fleet that matches on nothing shows WHY, rather than
    // thirteen tables of dashes. This is the evidence the field names have
    // never been documented for.
    diagnostics: joined.matched === 0
      ? { candidates: joined.candidates, sampleEntries: joined.unmatchedEntries }
      : null,
  });
});
