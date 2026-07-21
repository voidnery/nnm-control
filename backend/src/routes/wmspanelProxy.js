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

// --- WMSPanel stream objects (canonical schemas pinned from live dump) ---
// NOTE: appended in v0.3.11 — the v0.3.8/v0.3.9 insertions silently no-opped
// (patch anchor had been removed earlier), which is why the tabs 404'd.

// UDP/SRT outputs: view + edit (source_streams incl. PIDs, paused)
r.get('/server/:id/udp', requirePerm('wmsobjects.view'), loadMapped,
  proxy(async rq => wmspanel.udpList(await cfg(), rq.mapped.wmspanelServerId)));
r.put('/server/:id/udp/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.udpUpdate(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId, rq.body || {})));

// MPEGTS outgoing: view + edit + pause/resume/restart
r.get('/server/:id/outgoing', requirePerm('wmsobjects.view'), loadMapped,
  proxy(async rq => wmspanel.outgoingList(await cfg(), rq.mapped.wmspanelServerId)));
r.put('/server/:id/outgoing/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.outgoingUpdate(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId, rq.body || {})));
r.post('/server/:id/outgoing/:objId/:action(pause|resume|restart)', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.outgoingAction(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId, rq.params.action)));

// Hot swap: full CRUD
r.get('/server/:id/hotswap', requirePerm('wmsobjects.view'), loadMapped,
  proxy(async rq => wmspanel.hotswapList(await cfg(), rq.mapped.wmspanelServerId)));
r.post('/server/:id/hotswap', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.hotswapCreate(await cfg(), rq.mapped.wmspanelServerId, rq.body || {})));
r.put('/server/:id/hotswap/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.hotswapUpdate(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId, rq.body || {})));
r.delete('/server/:id/hotswap/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.hotswapDelete(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId)));

// Active streams via WMSPanel Streams API (Deep stats). 2 upstream calls per
// load — the UI defaults to manual refresh to respect the 15k/day budget.
r.get('/server/:id/streams', requirePerm('streams.view'), loadMapped, proxy(async rq => {
  const c = await cfg();
  const ds = await wmspanel.dataSlices(c);
  const sliceId = ds.data_slices?.[0]?.id;
  if (!sliceId) {
    const e = new Error('No data slices available on the WMSPanel account');
    e.data = ds;
    throw e;
  }
  // kind=active first; if empty, retry unfiltered (some accounts/kinds return
  // nothing for 'active'); keep raw upstream for the Debug expander.
  const tried = [];
  let d = await wmspanel.streamsQuery(c, sliceId, rq.mapped.wmspanelServerId, 'active');
  tried.push({ kind: 'active', count: (d.streams || []).length });
  if (!(d.streams || []).length) {
    d = await wmspanel.streamsQuery(c, sliceId, rq.mapped.wmspanelServerId, null);
    tried.push({ kind: null, count: (d.streams || []).length });
  }
  const streams = (d.streams || []).map(x => {
    const raw = typeof x === 'string' ? x : (x?.name || '');
    const parts = String(raw).split('/');
    const parsed = parts.length >= 3 ? { app: parts[1], stream: parts.slice(2).join('/') } : { app: '', stream: raw };
    return { raw, ...parsed, ...(typeof x === 'object' && x !== null ? { meta: x } : {}) };
  });
  return { streams, sliceId, debug: { tried, rawSample: (d.streams || []).slice(0, 3) } };
}));


// MPEGTS incoming: full CRUD (schema from live dump: name, protocol, ip,
// port, receive_mode, parameters, description, tags; status/bandwidth are
// read-only telemetry)
r.get('/server/:id/incoming', requirePerm('wmsobjects.view'), loadMapped,
  proxy(async rq => wmspanel.incomingList(await cfg(), rq.mapped.wmspanelServerId)));
r.post('/server/:id/incoming', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.incomingCreate(await cfg(), rq.mapped.wmspanelServerId, rq.body || {})));
r.put('/server/:id/incoming/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.incomingUpdate(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId, rq.body || {})));
r.delete('/server/:id/incoming/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.incomingDelete(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId)));

// MPEGTS outgoing: create/delete complete the earlier list/update/actions
r.post('/server/:id/outgoing', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.outgoingCreate(await cfg(), rq.mapped.wmspanelServerId, rq.body || {})));
r.delete('/server/:id/outgoing/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.outgoingDelete(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId)));
