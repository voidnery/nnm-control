import { Router } from 'express';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { Settings } from '../models/Settings.js';
import { NimbleServer } from '../models/NimbleServer.js';
import { DeliveryNetwork } from '../models/DeliveryNetwork.js';
import { wmspanel } from '../services/wmspanelClient.js';
import { planRoutes } from '../services/deliveryPlan.js';
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

deliveryRoutesRouter.delete('/routes/:objId', requirePerm('cdn.manage'), proxy(async rq =>
  wmspanel.routeDelete(await cfg(), rq.params.objId)));

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
