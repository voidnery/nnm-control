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

  // Which native endpoint holds which family is not something to assume.
  // Ports 35001+ turned up under srt_receiver_stats while being configured as
  // UDP Streaming — SRT Out in this panel — so a fixed endpoint-per-tab map
  // was wrong, and wrong in a way that produced an empty column and a
  // plausible-looking explanation.
  //
  // Both SRT endpoints are asked and their entries merged. The join then
  // decides by identifier or by port, which is what actually ties an entry to
  // an object; nothing depends on my reading of Nimble's naming.
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

  // A socket can appear in both lists; the local port identifies it.
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

  // When the list comes out empty, the question is whether Nimble reported
  // nothing or whether we looked in the wrong place — and those need opposite
  // fixes. The shape of the response answers it, so the shape is returned:
  // key names, their types and their sizes. Names and types only, never
  // values, because this crosses a screen and a response can carry addresses.
  const shapeOf = (v, depth = 0) => {
    if (Array.isArray(v)) {
      return { type: 'array', length: v.length, of: v.length && depth < 2 ? shapeOf(v[0], depth + 1) : undefined };
    }
    if (v && typeof v === 'object') {
      return {
        type: 'object',
        keys: Object.keys(v).slice(0, 40),
        children: depth < 2
          ? Object.fromEntries(Object.entries(v).slice(0, 12).map(([k, x]) => [k, shapeOf(x, depth + 1)]))
          : undefined,
      };
    }
    return { type: typeof v };
  };
  const objects = wmsRes.status === 'fulfilled' ? src.pick(wmsRes.value) : [];
  const joined = joinLive(entries, objects);

  // Ports that overlap mean the two sides describe the same sockets and a
  // failure to pair is a naming problem. No overlap at all means they describe
  // different streams — for which "could not be matched" is misleading: there
  // was never anything to match, and nothing is wrong.
  const nPorts = new Set(entries.map(e => (localPort(e.id) || '').replace('port:', '')).filter(Boolean));
  const wPorts = new Set(objects.map(o => String(o.port || '')).filter(Boolean));
  const portOverlap = [...wPorts].filter(p => nPorts.has(p)).length;

  // The same measurement for identifiers, over the FULL sets. Two five-entry
  // samples failing to overlap is what sent this epic down a wrong path for
  // several rounds — samples answer nothing, sets answer it exactly.
  const nIds = new Set(entries.map(e => String(e.setting_id ?? e.settingId ?? '').toLowerCase()).filter(Boolean));
  const wIds = new Set(objects.map(o => String(o.id ?? '').toLowerCase()).filter(Boolean));
  const idOverlap = [...wIds].filter(id => nIds.has(id)).length;

  res.json({
    kind,
    available: true,
    strategy: joined.strategy,
    matched: joined.matched,
    portOverlap,
    objects: objects.length,
    entries: entries.length,
    // The subject travels with the reading. The history dialog then asks for
    // the series this row's data is actually in, instead of deriving a subject
    // from an id space the collector never used.
    live: Object.fromEntries(Object.entries(joined.byObjectId).map(([id, list]) => {
      const first = Array.isArray(list) ? list[0] : list;
      const ident = entryIdentity(first);
      return [id, {
        ...liveSummary(list),
        subject: ident ? `${first.__series || 'srt-receiver'}:${ident}` : null,
      }];
    })),
    // Returned so a fleet that matches on nothing shows WHY, rather than
    // thirteen tables of dashes. This is the evidence the field names have
    // never been documented for.
    // A partial match is its own story: some streams paired and some did not,
    // and the ones that did not are exactly the interesting ones. Reported
    // whenever anything is unmatched, not only when everything is.
    unmatched: joined.unmatchedObjects.length,
    diagnostics: joined.matched < objects.length
      ? {
        candidates: joined.candidates,
        sampleEntries: joined.unmatchedEntries,
        // Only when the list itself came out empty: that is when the useful
        // question stops being "which key" and becomes "which key was I
        // supposed to read the list out of".
        responseShape: entries.length === 0 ? shapeOf(nativeRes.value) : undefined,
        endpoint: src.native,
        // The identifiers on each side, so a mismatch is visible as a
        // mismatch rather than as an absence. Ids only — no addresses.
        // Ports, not just ids. Two systems can name the same stream
        // differently and still be talking about the same socket — and when
        // the ports do not overlap either, they are not the same streams at
        // all, which is a different conclusion entirely.
        // Counts and the overlap first. The truncated lists below read as the
        // whole picture and are not — a 20-item slice of 61 ports is how I
        // concluded "no overlap" from a sample that simply had not reached it.
        // Sets, not samples.
        settingIdCount: nIds.size,
        objectIdCount: wIds.size,
        idOverlap,
        overlappingIds: [...wIds].filter(id => nIds.has(id)).slice(0, 10),
        nimblePortCount: nPorts.size,
        wmspanelPortCount: wPorts.size,
        portOverlap,
        overlappingPorts: [...wPorts].filter(p => nPorts.has(p)).slice(0, 20),
        nimblePorts: [...new Set(entries.map(e => localPort(e.id)).filter(Boolean))].slice(0, 20),
        wmspanelPorts: [...new Set(objects.map(o => o.port).filter(Boolean))].slice(0, 20),
        sampleEntryIds: entries.slice(0, 5).map(e => ({
          setting_id: e.setting_id ?? null, name: e.name ?? null,
          localPort: localPort(e.id), hasStats: Boolean(e.stats),
        })),
        sampleObjectIds: objects.slice(0, 5).map(o => ({ id: String(o.id), name: o.name, port: o.port })),
      }
      : null,
  });
});
