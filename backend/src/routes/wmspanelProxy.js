import { Router } from 'express';
import { Settings } from '../models/Settings.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { syncServersFromWmspanel } from '../services/wmspanelSync.js';

// Permission-gated proxy to WMSPanel Control API (persistent settings).
export const wmspanelRouter = Router();
wmspanelRouter.use(requireAuth);

async function cfg() {
  const s = await Settings.load();
  return s.wmspanel;
}

function proxy(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      const code = e.code === 'NO_CREDS' ? 409 : 502;
      res.status(code).json({ error: e.message, upstream: e.data ?? null });
    }
  };
}

// Manual fleet sync (also runs automatically every 10 min in wmspanel mode).
wmspanelRouter.post('/sync', requirePerm('servers.manage'), proxy(async () => {
  return await syncServersFromWmspanel({ force: true });
}));

// WMSPanel servers list — used for mapping our servers to WMSPanel ids.
wmspanelRouter.get('/servers', requirePerm('servers.manage'), proxy(async () => {
  const data = await wmspanel.listServers(await cfg());
  return { servers: data.servers || [] };
}));

// Resolve our server -> wmspanelServerId or fail clearly.
async function loadMapped(req, res, next) {
  const server = await NimbleServer.findById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!server.wmspanelServerId) {
    return res.status(409).json({ error: 'Server is not mapped to a WMSPanel server id. Set it in server settings.' });
  }
  req.mapped = server;
  next();
}

const r = wmspanelRouter;
r.get('/server/:id/republish', requirePerm('republish.view'), loadMapped,
  proxy(async rq => wmspanel.republishList(await cfg(), rq.mapped.wmspanelServerId)));
r.post('/server/:id/republish', requirePerm('republish.manage'), loadMapped,
  proxy(async rq => wmspanel.republishCreate(await cfg(), rq.mapped.wmspanelServerId, rq.body || {})));
r.put('/server/:id/republish/:ruleId', requirePerm('republish.manage'), loadMapped,
  proxy(async rq => wmspanel.republishUpdate(await cfg(), rq.mapped.wmspanelServerId, rq.params.ruleId, rq.body || {})));
r.delete('/server/:id/republish/:ruleId', requirePerm('republish.manage'), loadMapped,
  proxy(async rq => wmspanel.republishDelete(await cfg(), rq.mapped.wmspanelServerId, rq.params.ruleId)));
r.post('/server/:id/republish/:ruleId/restart', requirePerm('republish.manage'), loadMapped,
  proxy(async rq => wmspanel.republishRestart(await cfg(), rq.mapped.wmspanelServerId, rq.params.ruleId)));
