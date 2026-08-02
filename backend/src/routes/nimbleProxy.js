import { Router } from 'express';
import { NimbleServer } from '../models/NimbleServer.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { nimble } from '../services/nimbleClient.js';
import { Settings } from '../models/Settings.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { joinLive, liveSummary, localPort, entryIdentity, entryList as asList } from '../services/streamJoin.js';

// The collector labels a series by the endpoint the entry came from, so that
// label must be the same here. Inferring it from the presence of a `recv`
// block would be guessing again — and the endpoint is known, because this is
// the code that called it.
// serverId -> { at, ports:Set }
const objectPortCache = new Map();
const OBJECT_PORT_TTL_MS = 120_000;

// Every port this server's WMSPanel objects use, across all the families.
// Cached, because it exists to answer a question asked once per page.
async function allObjectPorts(server, settings) {
  const key = String(server._id);
  const hit = objectPortCache.get(key);
  if (hit && Date.now() - hit.at < OBJECT_PORT_TTL_MS) return hit.ports;

  const ports = new Set();
  const lists = await Promise.allSettled([
    wmspanel.incomingList(settings.wmspanel, server.wmspanelServerId),
    wmspanel.udpList(settings.wmspanel, server.wmspanelServerId),
    wmspanel.outgoingList(settings.wmspanel, server.wmspanelServerId),
  ]);
  for (const r of lists) {
    if (r.status !== 'fulfilled') continue;
    for (const o of (r.value?.settings || r.value?.streams || [])) {
      if (o?.port) ports.add(String(o.port));
    }
  }
  objectPortCache.set(key, { at: Date.now(), ports });
  return ports;
}

async function serverWideOverlap(server, settings, entries) {
  try {
    const objectPorts = await allObjectPorts(server, settings);
    if (!objectPorts.size) return null;
    const socketPorts = new Set(entries.map(e => (localPort(e.id) || '').replace('port:', '')).filter(Boolean));
    if (!socketPorts.size) return null;
    return [...objectPorts].filter(p => socketPorts.has(p)).length;
  } catch { return null; }
}

const SERIES_OF = { srtReceiverStats: 'srt-receiver', srtSenderStats: 'srt-sender', republishStats: 'republish' };


// Permission-gated proxy of Nimble native API per managed server.
export const nimbleRouter = Router();
nimbleRouter.use(requireAuth);

// Hard gate: while the control plane is WMSPanel API, the native API is fully
// disabled — no calls leave the panel through this router.
// Read-only endpoints that stay available whatever the control plane is.
//
// The block below exists so that CONTROL does not go two ways at once: with
// WMSPanel as the control plane, a change made through the native API is
// silently overwritten on its next sync. Reading a counter is not a change,
// and the stats collector has been polling this same API in this same mode all
// along — so blocking reads here made the panel refuse itself data it was
// already collecting.
const READ_ONLY = [/^\/[^/]+\/live-objects\//];

nimbleRouter.use(async (req, res, next) => {
  if (READ_ONLY.some(re => re.test(req.path))) return next();
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

  // Which native endpoint holds which family is not something to assume: ports
  // 35001+ turned up under srt_receiver_stats while being configured as UDP
  // Streaming. Both SRT endpoints are asked and their entries merged; the join
  // decides by identifier or by local port.
  const SOURCES = {
    incoming: { native: ['srtReceiverStats', 'srtSenderStats'], wms: 'incomingList', pick: (d) => d.streams || d.settings || [] },
    outgoing: { native: ['srtSenderStats', 'srtReceiverStats'], wms: 'outgoingList', pick: (d) => d.streams || d.settings || [] },
    udp: { native: ['srtSenderStats', 'srtReceiverStats'], wms: 'udpList', pick: (d) => d.settings || [] },
    republish: { native: ['republishStats'], wms: 'republishList', pick: (d) => d.rules || d.republish_rules || [] },
  };
  const src = SOURCES[kind];
  if (!src) return res.status(400).json({ error: `unknown kind "${kind}"` });

  const settings = await Settings.load();
  // Independent on purpose: native stats are worth having even when WMSPanel
  // is unreachable, and the object list is worth having when a server is.
  const [wmsRes, ...nativeRes] = await Promise.allSettled([
    wmspanel[src.wms](settings.wmspanel, server.wmspanelServerId),
    ...src.native.map(fn => nimble[fn](server)),
  ]);

  // One endpoint failing is not a reason to lose the other: they cover
  // different sockets and either alone is worth having.
  const ok = nativeRes.filter(r => r.status === 'fulfilled');
  if (!ok.length) {
    return res.json({
      kind, available: false,
      reason: String(nativeRes[0]?.reason?.message || nativeRes[0]?.reason).slice(0, 200),
    });
  }

  const seen = new Set();
  const entries = [];
  nativeRes.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const series = SERIES_OF[src.native[i]] || 'srt-receiver';
    for (const e of asList(r.value)) {
      const key = `${e.setting_id ?? ''}|${e.id ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Carried, not inferred: which endpoint answered decides which series
      // the collector filed it under.
      Object.defineProperty(e, '__series', { value: series, enumerable: false });
      entries.push(e);
    }
  });

  const objects = wmsRes.status === 'fulfilled' ? src.pick(wmsRes.value) : [];
  const joined = joinLive(entries, objects);

  // Ports that overlap mean the two sides describe the same sockets and a
  // failure to pair is a naming problem. No overlap at all means one of two
  // things, and they are not the same:
  //
  //   * these objects genuinely live on another tab, or
  //   * the native URL and the WMSPanel server mapping point at DIFFERENT
  //     MACHINES — which is a misconfiguration, not a fact about streams, and
  //     it cost this investigation a dozen rounds because nothing said so.
  //
  // The second is recognisable: a server that is wired correctly has SOME
  // socket in common with SOME object across its tabs. If a single tab shows
  // no overlap the first reading holds; if the whole server does, the wiring
  // is wrong.
  const nPorts = new Set(entries.map(e => (localPort(e.id) || '').replace('port:', '')).filter(Boolean));
  const wPorts = new Set(objects.map(o => String(o.port || '')).filter(Boolean));
  const portOverlap = [...wPorts].filter(p => nPorts.has(p)).length;

  // No investigative payload here. Shapes, samples, id sets and hardware
  // fingerprints belong in tools/, run deliberately — not shipped in a
  // response that is polled every ten seconds, and not putting server
  // internals on a screen. What remains is what an operator acts on.
  res.json({
    kind,
    available: true,
    strategy: joined.strategy,
    matched: joined.matched,
    unmatched: joined.unmatchedObjects.length,
    portOverlap,
    // Whether ANY of this server's objects, on any tab, share a socket with
    // what its native API reports. Cheap because the lists are already in
    // memory for the tab being viewed; the rest come from a short cache.
    serverOverlap: await serverWideOverlap(server, settings, entries),
    objects: objects.length,
    entries: entries.length,
    // The subject travels with the reading, so the history dialog asks for the
    // series this row's data is actually in rather than deriving one.
    live: Object.fromEntries(Object.entries(joined.byObjectId).map(([id, list]) => {
      const first = Array.isArray(list) ? list[0] : list;
      const ident = entryIdentity(first);
      return [id, {
        ...liveSummary(list),
        subject: ident ? `${first.__series || 'srt-receiver'}:${ident}` : null,
      }];
    })),
  });
});
