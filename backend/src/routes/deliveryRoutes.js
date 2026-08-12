import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { Settings } from '../models/Settings.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { DeliveryNetwork } from '../models/DeliveryNetwork.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { planRoutes } from '../services/deliveryPlan.js';
import { networkState, indexStreams, probeReason } from '../services/networkState.js';
import { parsePlaylist, movedOn, classifyProbe } from '../services/playlistProbe.js';
import { playbackPath } from '../services/protocols.js';
import { configOverview } from '../services/configOverview.js';
import { cacheReport } from '../services/cacheReport.js';
import { status as geoStatus } from '../services/geoip.js';
import { nimble, agentIsLive } from '../services/nimbleClient.js';
import { logEvent } from '../services/audit.js';

export const deliveryRoutesRouter = Router();
deliveryRoutesRouter.use(requireAuth);

const cfg = async () => (await Settings.load()).wmspanel;

const proxy = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(e.code === 'NO_CREDS' ? 409 : 502).json({ error: e.message, upstream: e.data ?? null }); }
};

// Raw route objects, as WMSPanel holds them. Passed through rather than
// reshaped: this account has none yet, so the first populated response is the
// first time anyone sees what a live route actually looks like, and a mapping
// layer written before that would be a guess presented as a fact.
deliveryRoutesRouter.get('/routes', requirePerm('cdn.view'), proxy(async () =>
  wmspanel.routeList(await cfg())));

deliveryRoutesRouter.delete('/routes/:objId', requirePerm('cdn.manage'), async (req, res) => {
  try {
    const r = await wmspanel.routeDelete(await cfg(), req.params.objId);
    await logEvent(req, 'cdn.route.delete', { routeId: req.params.objId });
    res.json(r);
  } catch (e) {
    res.status(e.code === 'NO_CREDS' ? 409 : 502).json({ error: e.message, upstream: e.data ?? null });
  }
});

// Which applications actually exist upstream.
//
// The page used to open with an empty text field and three disabled buttons,
// and the operator was expected to know what to type. They do not: the names
// live on the origin, so the panel can go and read them. Offered as a starting
// point, not as the only choice — an application can exist in the plan before
// anything is published under it.
deliveryRoutesRouter.get('/networks/:id/applications', requirePerm('cdn.view'), async (req, res) => {
  const g = await gather(req.params.id);
  if (g.error) return res.status(404).json({ error: g.error });
  const byId = new Map(g.servers.map(x => [String(x._id), x]));
  const uppers = (g.network.nodes || [])
    .filter(n => ['origin', 'mid', 'ingest'].includes(n.role) && n.enabled !== false)
    .map(n => byId.get(String(n.server))).filter(Boolean);

  const found = new Map();   // application -> { streams, servers:Set }
  const asked = [];
  await Promise.all(uppers.map(async (srv) => {
    const meta = {};
    try {
      const idx = indexStreams(await nimble.liveStreams(srv, meta));
      asked.push({ server: srv.name, ok: true, transport: meta.transport || 'direct' });
      for (const [app, entries] of idx) {
        const cur = found.get(app) || { application: app, streams: 0, servers: [] };
        cur.streams += entries.length;
        if (!cur.servers.includes(srv.name)) cur.servers.push(srv.name);
        found.set(app, cur);
      }
    } catch (e) {
      asked.push({ server: srv.name, ok: false, transport: meta.transport || 'direct',
                   reason: probeReason(e, agentIsLive(srv)) });
    }
  }));
  res.json({ applications: [...found.values()].sort((a, b) => a.application.localeCompare(b.application)), asked });
});

// Everything that is switched on, and everything that quietly is not.
//
// The settings deciding how this network behaves live on four tabs and two
// other pages; several of them interact in ways invisible from either side.
// Gathered here so "what is actually enabled" is one question with one answer.
deliveryRoutesRouter.get('/networks/:id/overview', requirePerm('cdn.view'), async (req, res) => {
  const g = await gather(req.params.id);
  if (g.error) return res.status(404).json({ error: g.error });
  const channels = String(req.query.channels || '').split(/[\s,]+/).filter(Boolean);
  const geo = await geoStatus().catch(() => null);
  res.json(configOverview({
    network: g.network, servers: g.servers,
    originApps: g.originApps, routes: g.existingRoutes, geo, channels,
  }));
});

// What the cache is doing, per edge.
//
// The one number that says whether this is a delivery network or three
// parallel proxies. WMSPanel does not have it; `/manage/server_status` does,
// which is the endpoint the panel already polls for metrics — Softvelum's own
// Zabbix templates read RAM cache status from exactly there.
//
// Read through the shared native client, so it prefers the agent like every
// other management call.
deliveryRoutesRouter.post('/networks/:id/cache', requirePerm('cdn.view'), async (req, res) => {
  const g = await gather(req.params.id);
  if (g.error) return res.status(404).json({ error: g.error });
  const chunkSeconds = Number(req.body?.chunkSeconds) > 0 ? Number(req.body.chunkSeconds) : 6;

  const byId = new Map(g.servers.map(x => [String(x._id), x]));
  const edges = (g.network.nodes || [])
    .filter(n => n.role === 'edge' && n.enabled !== false)
    .map(n => byId.get(String(n.server))).filter(Boolean);

  const rows = await Promise.all(edges.map(async (srv) => {
    const meta = {};
    try {
      const [status, live] = await Promise.all([
        nimble.serverStatus(srv, meta),
        nimble.liveStreams(srv).catch(() => null),
      ]);
      const streams = [];
      for (const entries of (live ? indexStreams(live) : new Map()).values()) streams.push(...entries);
      return {
        server: srv.name, ok: true, transport: meta.transport || 'direct',
        ...cacheReport({ status, streams, chunkSeconds }),
      };
    } catch (e) {
      // Named, not silently absent: an edge the panel could not ask is a gap
      // in the picture, and pretending it has no cache would be a claim.
      return { server: srv.name, ok: false, reason: probeReason(e, agentIsLive(srv)),
               error: String(e?.message || e).slice(0, 200) };
    }
  }));

  res.json({ rows, chunkSeconds, at: new Date().toISOString() });
});

// Be the viewer.
//
// Three milestones inferred delivery from what an edge was streaming, and an
// HLS re-streaming route streams nothing until asked — so an idle edge read as
// broken and a working network could not hand out a link. The only honest test
// is to fetch the playlist, which is also what warms the cache, so the check
// pays for itself.
//
// Sent from the panel on purpose: it is outside the edge, which is the vantage
// point a viewer has. Asking the edge to fetch from itself would test a loop.
deliveryRoutesRouter.post('/networks/:id/watch', requirePerm('cdn.view'), async (req, res) => {
  const g = await gather(req.params.id);
  if (g.error) return res.status(404).json({ error: g.error });
  const application = String(req.body?.application || '').trim();
  const stream = String(req.body?.stream || '').trim();
  if (!application || !stream) {
    return res.status(400).json({ error: 'application-and-stream-required', code: 'application-and-stream-required' });
  }

  const byId = new Map(g.servers.map(x => [String(x._id), x]));
  // The path the viewer would fetch for this channel's packaging. Probing the
  // HLS playlist for a DASH channel would answer about a URL nobody is given.
  // One helper for every packaging, including HLS. Branching so that HLS kept
  // its old builder left two places constructing the same path, which is how
  // the probe and the link drift apart — and the gate that caught it exists
  // because they already did once.
  const protocol = String(req.body?.protocol || 'hls');
  const path = playbackPath(protocol, application, stream);
  const targets = [];
  for (const n of g.network.nodes || []) {
    if (!['origin', 'edge', 'mid'].includes(n.role) || n.enabled === false) continue;
    const srv = byId.get(String(n.server));
    if (srv) targets.push({ role: n.role, server: srv });
  }

  const once = async (url) => {
    const started = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
      const text = r.status === 200 ? await r.text() : '';
      return { status: r.status, ms: Date.now() - started, playlist: r.status === 200 ? parsePlaylist(text) : null };
    } catch (e) {
      return { error: String(e?.message || e), ms: Date.now() - started };
    }
  };

  const results = await Promise.all(targets.map(async ({ role, server }) => {
    const url = `http://${server.host}:${server.httpPort || 8081}${path}`;
    const first = await once(url);
    // A second reading, a moment later, is the only way to tell a live edge
    // from one serving the same frozen playlist forever. Skipped when the
    // first attempt already failed — there is nothing to compare.
    let second = null;
    if (first.status === 200 && first.playlist?.valid && first.playlist.kind === 'media') {
      await new Promise(r => setTimeout(r, Math.min(6000, (first.playlist.targetDuration || 4) * 1000 + 500)));
      second = await once(url);
    }
    const advanced = second ? movedOn(first.playlist, second.playlist) : null;
    return {
      role, server: server.name, url,
      status: first.status ?? null, ms: first.ms,
      playlist: first.playlist || null,
      verdict: classifyProbe({ ...first, advanced }),
    };
  }));

  res.json({ path, application, stream, results, at: new Date().toISOString() });
});

// What the servers say, next to what the plan says. Reads live_streams_status
// off each box directly — the native API, so it costs no WMSPanel quota and can
// be asked as often as an operator wants to look.
deliveryRoutesRouter.post('/networks/:id/state', requirePerm('cdn.view'), async (req, res) => {
  const g = await gather(req.params.id);
  if (g.error) return res.status(404).json({ error: g.error });
  const channels = (Array.isArray(req.body?.channels) ? req.body.channels : [])
    .map(x => String(x).trim()).filter(Boolean);

  // Only the boxes this network actually uses, and each one asked once even
  // when it appears as the upstream of several edges.
  const wanted = new Set((g.network.nodes || []).map(n => String(n.server)));
  const targets = g.servers.filter(s => wanted.has(String(s._id)));
  const live = {};
  const probe = {};
  await Promise.all(targets.map(async (s) => {
    const id = String(s._id);
    const hadAgent = agentIsLive(s);
    const meta = {};
    try {
      // Reads go through the shared native client, never a bare fetch from
      // here: the client is what prefers the agent, and the rule "the panel
      // does not dial a server that has an agent" only holds while every
      // caller goes through it. audit checks that this file has no fetch.
      live[id] = indexStreams(await nimble.liveStreams(s, meta));
      probe[id] = { ok: true, transport: meta.transport || 'direct', hadAgent };
    } catch (e) {
      // A box that cannot be reached is a finding, not an absence of streams:
      // null says "asked and failed", undefined would say "never asked".
      live[id] = null;
      probe[id] = { ok: false, hadAgent, transport: meta.transport || (hadAgent ? 'agent' : 'direct'),
                    reason: probeReason(e, hadAgent), error: String(e?.message || e).slice(0, 200) };
    }
  }));

  const unreachable = targets.filter(s => live[String(s._id)] === null)
    .map(s => ({ server: s.name, ...probe[String(s._id)] }));
  res.json({ ...networkState({ ...g, channels, live, probe }), channels, unreachable });
});

async function gather(networkId) {
  const network = await DeliveryNetwork.findById(networkId);
  if (!network) return { error: 'Network not found' };
  const servers = await NimbleServer.find();
  const c = await cfg();
  const [originApps, routes] = await Promise.all([
    wmspanel.originAppList(c).then(r => r.settings || []).catch(() => []),
    wmspanel.routeList(c).then(r => r.routes || []).catch(() => []),
  ]);
  return { network, servers, originApps, existingRoutes: routes };
}

// The plan, computed and shown before anything is written. Deliberately a GET
// with no side effects: an operator should be able to look at what a network
// implies as often as they like without it costing a change.
deliveryRoutesRouter.post('/networks/:id/plan', requirePerm('cdn.view'), async (req, res) => {
  const g = await gather(req.params.id);
  if (g.error) return res.status(404).json({ error: g.error });
  const channels = (Array.isArray(req.body?.channels) ? req.body.channels : [])
    .map(x => String(x).trim()).filter(Boolean);
  res.json({ ...planRoutes({ ...g, channels }), channels });
});

deliveryRoutesRouter.post('/networks/:id/apply', requirePerm('cdn.manage'), async (req, res) => {
  const g = await gather(req.params.id);
  if (g.error) return res.status(404).json({ error: g.error });
  const channels = (Array.isArray(req.body?.channels) ? req.body.channels : [])
    .map(x => String(x).trim()).filter(Boolean);

  const plan = planRoutes({ ...g, channels });
  // Recomputed here rather than trusted from the client: the fleet may have
  // changed between looking at a plan and pressing the button, and the reason
  // this gate exists is precisely that the change is invisible.
  if (plan.blocking.length) {
    return res.status(422).json({ error: 'plan is blocked', ...plan });
  }
  const work = plan.planned.filter(p => p.action !== 'keep');
  if (!work.length) return res.json({ ok: true, applied: 0, steps: [], plan });

  const c = await cfg();
  const steps = [];
  const created = [];   // for rollback: only what this run made
  let ok = true;

  for (const item of work) {
    const label = `${item.action} ${item.server} ${item.from} -> ${item.to}`;
    try {
      if (item.action === 'create') {
        const r = await wmspanel.routeCreate(c, {
          from: item.from, to: item.to, servers: [item.wmspanelServerId],
        });
        let id = r?.route?.id || r?.id || '';
        if (!id) {
          // The reference says a create answers with the route, but this
          // account had none to learn from, and a response without an id is
          // not proof that nothing was written — treating it as a failure
          // would roll back a route that exists. Look for it instead.
          const back = await wmspanel.routeList(c).catch(() => ({ routes: [] }));
          const found = (back.routes || []).find(x =>
            x.to === item.to && (x.servers || []).map(String).includes(item.wmspanelServerId));
          if (!found) {
            const e = new Error('WMSPanel returned no id and the route is not in the list afterwards');
            e.upstream = r;
            throw e;
          }
          id = found.id;
        }
        created.push(id);

        // Read back. The account had no routes at all before this, so the
        // response shape is unproven; a create that reports success and stores
        // something else is the failure mode worth paying a call to exclude.
        const back = await wmspanel.routeGet(c, id).catch(() => null);
        const stored = back?.route || null;
        const matches = stored && stored.to === item.to;
        steps.push({ step: label, ok: true, routeId: id,
                     verified: matches ? 'read-back matches' : 'read-back differs or unavailable',
                     stored: stored || undefined });
        if (stored && !matches) {
          throw new Error(`stored route points at ${stored.to}, not ${item.to}`);
        }
      } else {
        const r = await wmspanel.routeUpdate(c, item.routeId, {
          from: item.from, to: item.to, servers: [item.wmspanelServerId],
        });
        steps.push({ step: label, ok: true, routeId: item.routeId, was: item.was, upstream: r?.status });
      }
    } catch (e) {
      ok = false;
      // Roll back only the routes this run created. An update is left as it
      // is and reported: restoring the previous `to` would need the previous
      // object, and inventing it is worse than saying what happened.
      const undone = [];
      for (const id of created.reverse()) {
        try { await wmspanel.routeDelete(c, id); undone.push(id); }
        catch (err) { steps.push({ step: `rollback ${id}`, ok: false, error: err.message }); }
      }
      // What WMSPanel actually said, carried through rather than collapsed
      // into a status code: the client puts the parsed upstream body on
      // `data`, and it is the only thing that names the real cause.
      steps.push({ step: label, ok: false, error: e.message,
                   upstreamError: e.data ?? e.upstream ?? undefined,
                   rolledBack: undone.length ? `${undone.length} route(s) removed` : undefined });
      break;
    }
  }

  await logEvent(req, 'cdn.routes.apply', {
    network: String(req.params.id), channels, applied: steps.filter(s => s.ok).length, ok,
  });
  res.status(ok ? 200 : 502).json({ ok, applied: steps.filter(s => s.ok).length, steps, plan });
});
