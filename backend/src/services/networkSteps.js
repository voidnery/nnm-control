// Setting up a delivery network, as the six things an operator actually does.
//
// The panel had every one of these and put them on six equal tabs, which
// answers "where is that setting" and not "what do I do next" — and the second
// is the question somebody has the first time. Tabs are for looking at a thing
// you already understand.
//
// So: an ordered list, each step knowing whether it is done, from the same
// data the rest of the panel already computes. Not decorative ticks — a step
// reports `done` because the thing it describes is true.
//
// They deliberately do not block each other. An operator can open step five
// before step four; the panel says what is missing and gets out of the way. A
// wizard that leads by the hand is intolerable the second time, and a delivery
// network is configured once and then lived with for months.

export const STEP_IDS = ['members', 'upstreams', 'channels', 'nimble', 'links', 'verify'];

// `state` is one of:
//   done    — the thing this step describes is true
//   action  — something is wrong or missing and the operator must decide
//   empty   — nothing has been done here yet, which is not a fault
//   unknown — the panel could not find out, which is not the same as empty
export function networkSteps({ network, servers, channels = [], derived = null, watched = null }) {
  const byId = new Map(servers.map(s => [String(s._id ?? s.id), s]));
  const nodes = (network?.nodes || []).filter(n => n.enabled !== false);
  const origins = nodes.filter(n => n.role === 'origin');
  const edges = nodes.filter(n => n.role === 'edge');
  const gw = network?.gateway || {};

  const steps = [];
  const add = (id, state, summary, extra = {}) => steps.push({ id, state, summary, ...extra });

  // 1 — which machines are in it at all.
  if (!nodes.length) add('members', 'empty', { count: 0 });
  else if (!origins.length) add('members', 'action', { count: nodes.length }, { code: 'no-origin' });
  else if (!edges.length) add('members', 'action', { count: nodes.length }, { code: 'no-edges' });
  else add('members', 'done', {
    count: nodes.length,
    names: nodes.map(n => byId.get(String(n.server))?.name).filter(Boolean),
  });

  // 2 — and what each of them takes content from. Only mids and edges are fed
  // from inside the network; an origin is fed by whatever publishes into it,
  // which the panel does not model and must not ask about.
  const needUpstream = nodes.filter(n => ['mid', 'edge'].includes(n.role));
  const wired = needUpstream.filter(n => (n.upstream || []).length);
  if (!needUpstream.length) add('upstreams', 'empty', { wired: 0, total: 0 });
  else if (wired.length < needUpstream.length) {
    add('upstreams', 'action', { wired: wired.length, total: needUpstream.length }, { code: 'unwired' });
  } else add('upstreams', 'done', { wired: wired.length, total: needUpstream.length });

  // 3 — what it is supposed to carry.
  if (!channels.length) add('channels', 'empty', { count: 0 });
  else add('channels', 'done', {
    count: channels.length,
    names: channels.map(c => c.label || `${c.application}/${c.stream}`),
  });

  // 4 — what Nimble needs written for that, which the panel works out itself.
  if (!derived) add('nimble', 'unknown', {});
  else if (derived.blocking?.length) {
    add('nimble', 'action', { blocking: derived.blocking.length }, { code: 'blocked' });
  } else if (!channels.length || !edges.length) {
    // Nothing to derive is not "set up". Saying done here would put a tick on
    // a network that delivers nothing.
    add('nimble', 'empty', { pending: 0 });
  } else if (!derived.inSync) {
    add('nimble', 'action', { pending: (derived.summary?.create || 0) + (derived.summary?.update || 0) });
  } else add('nimble', 'done', { written: derived.summary?.keep || 0 });

  // 5 — how a viewer is handed a link. `direct` is a real answer, not an
  // absence: it is the default and it works. Only a gateway mode with no
  // machine behind it is a problem.
  if (gw.mode && gw.mode !== 'direct' && !gw.node) {
    add('links', 'action', { mode: gw.mode }, { code: 'gateway-without-node' });
  } else add('links', 'done', { mode: gw.mode || 'direct', policy: gw.policy || 'nearest' });

  // 6 — and whether any of it actually delivers. Never `done` on
  // configuration alone: everything above can be right while nothing arrives,
  // which is the whole reason the watch probe exists.
  if (!watched || !watched.total) add('verify', 'empty', {});
  else if (watched.failing) add('verify', 'action', { ok: watched.ok, total: watched.total }, { code: 'not-arriving' });
  else add('verify', 'done', { ok: watched.ok, total: watched.total });

  const done = steps.filter(s => s.state === 'done').length;
  return {
    steps,
    done,
    total: steps.length,
    // The first step that wants attention, so the page can open on it rather
    // than making the operator find it.
    next: steps.find(s => s.state === 'action')?.id
       || steps.find(s => s.state === 'empty')?.id
       || null,
  };
}
