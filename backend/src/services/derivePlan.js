import { planRoutes } from './deliveryPlan.js';

// What Nimble needs so that a channel is delivered — worked out, not asked for.
//
// The panel grew one screen per Nimble primitive: a tab for routes, a tab for
// origin applications, a field for ports, and the operator was the integration
// between them. That is backwards. An operator adds a channel to a network;
// everything Nimble requires to carry it follows from that, and the panel is
// the thing that knows how.
//
// So this takes intent — these channels, on this network — and returns the
// complete set of primitives, each one labelled with *why* it exists. The why
// matters more than the what: a panel that silently writes objects into an
// account is worse than one that asks, and the only thing that makes silent
// writing acceptable is being able to show the reasoning at any moment.
//
// Nothing here calls anything. It is a function of state the caller gathered,
// which is what lets the same computation drive the preview, the apply, and
// the "what did you do to my account" question three weeks later.

const trim = s => String(s || '').replace(/^\/+|\/+$/g, '');

export function derivePlan({ network, servers, channels, originApps = [], existingRoutes = [] }) {
  const apps = [...new Set(channels.map(c => trim(c.application)).filter(Boolean))];

  // Routes are the one primitive that already had a planner. Reused rather
  // than reimplemented: two answers to "which routes does this imply" would
  // drift, and the drift would be invisible until an apply did something the
  // preview did not show.
  const routes = planRoutes({ network, servers, originApps, existingRoutes, channels: apps });

  const items = routes.planned.map(p => ({
    kind: 'route',
    action: p.action,
    // Said in the operator's terms first. "A route on RU-2 so it can serve
    // test2" is the reason; `from`/`to` are the implementation of it.
    why: p.action === 'keep' ? 'already-right' : 'edge-needs-route',
    subject: p.server,
    application: p.application,
    detail: { from: p.from, to: p.to, routeId: p.routeId, was: p.was },
    // Everything a person needs to check the panel's arithmetic without
    // trusting it: which origin, which address, which port, and where the
    // port came from.
    provenance: p.action === 'keep' ? null : {
      origin: p.origin, host: p.originHost, hostSource: p.originHostSource,
      port: p.port, portSource: p.portSource,
    },
  }));

  // Channels whose network cannot carry them at all. Not a route problem —
  // there is nothing to route to — and worth separating, because the fix is
  // a different one.
  const unservable = [];
  for (const c of channels) {
    const app = trim(c.application);
    if (!items.some(i => i.application === app)) {
      unservable.push({ channel: `${c.application}/${c.stream}`, application: app });
    }
  }

  return {
    items,
    problems: routes.problems,
    blocking: routes.blocking,
    unservable,
    summary: {
      create: items.filter(i => i.action === 'create').length,
      update: items.filter(i => i.action === 'update').length,
      keep: items.filter(i => i.action === 'keep').length,
    },
    // True when the account already matches the intent. The apply button reads
    // this rather than counting items, so "nothing to do" and "everything is
    // blocked" can never look the same.
    inSync: items.every(i => i.action === 'keep') && routes.blocking.length === 0,
  };
}

// A one-line answer to "is this channel actually set up", for the row. Kept
// here rather than in the page so the dashboard and the network view cannot
// disagree about what a green tick means.
export function channelReadiness({ channel, plan }) {
  const app = trim(channel.application);
  const mine = plan.items.filter(i => i.application === app);
  // Blocked first. A blocking finding *removes* the items it blocks, so
  // checking for items first reported "nothing planned" — which reads as "you
  // have not set this up" about a channel the panel is deliberately refusing
  // to set up, and sends the operator to add something rather than to read the
  // reason.
  if (plan.blocking.some(b => !b.application || b.application === app)) {
    return { code: 'blocked', ready: false };
  }
  if (plan.unservable.some(u => u.application === app)) {
    return { code: 'unservable', ready: false };
  }
  if (!mine.length) return { code: 'nothing-planned', ready: false };
  const pending = mine.filter(i => i.action !== 'keep');
  if (!pending.length) return { code: 'ready', ready: true };
  return { code: 'pending', ready: false, pending: pending.length };
}
