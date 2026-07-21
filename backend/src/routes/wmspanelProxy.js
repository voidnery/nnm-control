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
  // Confirmed endpoint: /server/{sid}/live/streams — the full live view
  // (all protocols) incl. codecs, resolution, bandwidth, publisher, uptime.
  const d = await wmspanel.liveStreams(await cfg(), rq.mapped.wmspanelServerId);
  return { streams: d.streams || [] };
}));
r.delete('/server/:id/streams/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.liveStreamDelete(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId)));


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

// --- m8: distribution operations layer ---
// RTMP live pull: full CRUD + restart (fallback_urls = built-in feed reserve)
r.get('/server/:id/livepull', requirePerm('wmsobjects.view'), loadMapped,
  proxy(async rq => wmspanel.livePullList(await cfg(), rq.mapped.wmspanelServerId)));
r.post('/server/:id/livepull', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.livePullCreate(await cfg(), rq.mapped.wmspanelServerId, rq.body || {})));
r.put('/server/:id/livepull/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.livePullUpdate(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId, rq.body || {})));
r.delete('/server/:id/livepull/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.livePullDelete(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId)));
r.post('/server/:id/livepull/:objId/restart', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.livePullRestart(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId)));

// Live applications: CRUD (contains push credentials — audit masks them)
r.get('/server/:id/apps', requirePerm('wmsobjects.view'), loadMapped,
  proxy(async rq => wmspanel.liveAppList(await cfg(), rq.mapped.wmspanelServerId)));
r.post('/server/:id/apps', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.liveAppCreate(await cfg(), rq.mapped.wmspanelServerId, rq.body || {})));
r.put('/server/:id/apps/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.liveAppUpdate(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId, rq.body || {})));
r.delete('/server/:id/apps/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.liveAppDelete(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId)));

// RTMP interfaces: view
r.get('/server/:id/interfaces', requirePerm('wmsobjects.view'), loadMapped,
  proxy(async rq => wmspanel.rtmpInterfaceList(await cfg(), rq.mapped.wmspanelServerId)));

// --- m9: transcoders (account-level) ---
r.get('/transcoders', requirePerm('wmsobjects.view'),
  proxy(async () => wmspanel.transcoderList(await cfg())));
r.get('/transcoders/licenses', requirePerm('wmsobjects.view'),
  proxy(async () => wmspanel.transcoderLicenses(await cfg())));
r.get('/transcoders/:objId', requirePerm('wmsobjects.view'),
  proxy(async rq => wmspanel.transcoderGet(await cfg(), rq.params.objId)));
r.post('/transcoders/:objId/:action(pause|resume|clone)', requirePerm('wmsobjects.manage'),
  proxy(async rq => {
    const c = await cfg();
    if (rq.params.action === 'pause') return wmspanel.transcoderPause(c, rq.params.objId);
    if (rq.params.action === 'resume') return wmspanel.transcoderResume(c, rq.params.objId);
    return wmspanel.transcoderClone(c, rq.params.objId);
  }));

// --- m10: distribution (account-level: ABR / aliases / origin apps) ---
r.get('/abr', requirePerm('wmsobjects.view'), proxy(async () => wmspanel.abrList(await cfg())));
r.post('/abr', requirePerm('wmsobjects.manage'), proxy(async rq => wmspanel.abrCreate(await cfg(), rq.body || {})));
r.put('/abr/:objId', requirePerm('wmsobjects.manage'), proxy(async rq => wmspanel.abrUpdate(await cfg(), null, rq.params.objId, rq.body || {})));
r.delete('/abr/:objId', requirePerm('wmsobjects.manage'), proxy(async rq => wmspanel.abrDelete(await cfg(), rq.params.objId)));

r.get('/aliases', requirePerm('wmsobjects.view'), proxy(async () => wmspanel.aliasList(await cfg())));
r.post('/aliases', requirePerm('wmsobjects.manage'), proxy(async rq => wmspanel.aliasCreate(await cfg(), rq.body || {})));
r.put('/aliases/:objId', requirePerm('wmsobjects.manage'), proxy(async rq => wmspanel.aliasUpdate(await cfg(), null, rq.params.objId, rq.body || {})));
r.delete('/aliases/:objId', requirePerm('wmsobjects.manage'), proxy(async rq => wmspanel.aliasDelete(await cfg(), rq.params.objId)));

r.get('/originapps', requirePerm('wmsobjects.view'), proxy(async () => wmspanel.originAppList(await cfg())));
r.post('/originapps', requirePerm('wmsobjects.manage'), proxy(async rq => wmspanel.originAppCreate(await cfg(), rq.body || {})));
r.put('/originapps/:objId', requirePerm('wmsobjects.manage'), proxy(async rq => wmspanel.originAppUpdate(await cfg(), rq.params.objId, rq.body || {})));
r.delete('/originapps/:objId', requirePerm('wmsobjects.manage'), proxy(async rq => wmspanel.originAppDelete(await cfg(), rq.params.objId)));

// --- m11.2: CRUD completion ---
r.post('/server/:id/udp', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.udpCreate(await cfg(), rq.mapped.wmspanelServerId, rq.body || {})));
r.delete('/server/:id/udp/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.udpDelete(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId)));

r.post('/server/:id/interfaces', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.rtmpInterfaceCreate(await cfg(), rq.mapped.wmspanelServerId, rq.body || {})));
r.put('/server/:id/interfaces/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.rtmpInterfaceUpdate(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId, rq.body || {})));
r.delete('/server/:id/interfaces/:objId', requirePerm('wmsobjects.manage'), loadMapped,
  proxy(async rq => wmspanel.rtmpInterfaceDelete(await cfg(), rq.mapped.wmspanelServerId, rq.params.objId)));

r.delete('/transcoders/:objId', requirePerm('wmsobjects.manage'),
  proxy(async rq => wmspanel.transcoderDelete(await cfg(), rq.params.objId)));
r.put('/transcoders/:objId', requirePerm('wmsobjects.manage'),
  proxy(async rq => wmspanel.transcoderUpdate(await cfg(), null, rq.params.objId, rq.body || {})));
