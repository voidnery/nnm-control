import { Router } from 'express';
import { NimbleServer } from '../models/NimbleServer.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { nimble } from '../services/nimbleClient.js';

// Permission-gated proxy of Nimble native API per managed server.
export const nimbleRouter = Router();
nimbleRouter.use(requireAuth);

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
