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

// Five, not six. "What it is made of" and "who takes content from whom" opened
// the same table twice — the roles and the upstreams are edited in one place,
// so splitting them made a step that could not be completed on its own and a
// second card that repeated the first.
export const STEP_IDS = ['topology', 'channels', 'nimble', 'links', 'verify'];

// `state` is one of:
//   done    — the thing this step describes is true
//   action  — something is wrong or missing and the operator must decide
//   empty   — nothing has been done here yet, which is not a fault
//   unknown — the panel could not find out, which is not the same as empty
// `channels` is gone from the signature on purpose.
//
// Every step that used it now reads `carried`, and leaving an unused argument
// would invite the next reader to pass channel records and expect them to
// count for something. A network's membership is a set of applications; a
// channel record is an annotation on one stream inside one of them.
export function networkSteps({ network, servers, carried = null, derived = null, protection = null, watched = null }) {
  const byId = new Map(servers.map(s => [String(s._id ?? s.id), s]));
  const nodes = (network?.nodes || []).filter(n => n.enabled !== false);
  const origins = nodes.filter(n => n.role === 'origin');
  const edges = nodes.filter(n => n.role === 'edge');
  const gw = network?.gateway || {};

  const steps = [];
  const add = (id, state, summary, extra = {}) => steps.push({ id, state, summary, ...extra });

  // 1 — the shape of the network: which machines, in which role, taking
  // content from which. One step because it is one table.
  const needUpstream = nodes.filter(n => ['mid', 'edge'].includes(n.role));
  const wired = needUpstream.filter(n => (n.upstream || []).length);
  if (!nodes.length) add('topology', 'empty', { count: 0 });
  else if (!origins.length) add('topology', 'action', { count: nodes.length }, { code: 'no-origin' });
  else if (!edges.length) add('topology', 'action', { count: nodes.length }, { code: 'no-edges' });
  else if (needUpstream.length && wired.length < needUpstream.length) {
    add('topology', 'action', { count: nodes.length, wired: wired.length, total: needUpstream.length },
        { code: 'unwired' });
  } else {
    add('topology', 'done', {
      count: nodes.length, wired: wired.length, total: needUpstream.length,
      names: nodes.map(n => byId.get(String(n.server))?.name).filter(Boolean),
    });
  }

  // 3 — what it is supposed to carry, which is a set of **applications**.
  //
  // This counted channel records, and a channel record is one application and
  // one stream. So a network delivering an application with forty streams in
  // it read as "not set up" until somebody had typed forty channels, and a
  // stream that appeared on the origin afterwards was delivered — routes are
  // per application — while the step still called the network incomplete.
  //
  // A network that carries applications only because channels point at them is
  // not finished either: nothing records the membership, so nothing can answer
  // "should this network deliver that new stream". `action`, with the fix
  // named, rather than a tick over an inference.
  if (!carried) add('channels', 'unknown', {});
  else if (!carried.list.length) add('channels', 'empty', { count: 0 });
  else if (carried.conflicts.length) {
    add('channels', 'action', { count: carried.names.length, conflicts: carried.conflicts.length,
                                names: carried.conflicts }, { code: 'carried-conflict' });
  } else if (carried.undeclared.length) {
    add('channels', 'action', { count: carried.names.length, undeclared: carried.undeclared.length,
                                names: carried.undeclared }, { code: 'carried-undeclared' });
  } else add('channels', 'done', { count: carried.names.length, names: carried.names });

  // 4 — what Nimble needs written for that, which the panel works out itself.
  if (!derived) add('nimble', 'unknown', {});
  else if (derived.blocking?.length) {
    add('nimble', 'action', { blocking: derived.blocking.length }, { code: 'blocked' });
  } else if (!(carried?.names?.length) || !edges.length) {
    // Nothing to derive is not "set up". Saying done here would put a tick on
    // a network that delivers nothing.
    //
    // Counted channel records until this was found: step three was moved onto
    // applications and step four was left behind, so a network that declared
    // an application and had no channel records read "nothing to configure"
    // while routes were being planned for it. The same inconsistency step
    // three exists to remove, one step further down.
    add('nimble', 'empty', { pending: 0 });
  } else if (protection?.blocking?.length) {
    // Protection blocked is a different fault from routes blocked, and it is
    // the more dangerous one: the routes work, the stream is delivered, and it
    // is delivered to anybody.
    add('nimble', 'action', { blocking: protection.blocking.length }, { code: 'protection-blocked' });
  } else if (!derived.inSync || (protection && !protection.inSync)) {
    // Both halves count. The step said "all set up" while a channel's token
    // protection sat unwritten — everything the operator could see was green
    // and the stream was open.
    const routePending = (derived.summary?.create || 0) + (derived.summary?.update || 0);
    const protPending = (protection?.summary?.create || 0) + (protection?.summary?.update || 0);
    add('nimble', 'action', { pending: routePending + protPending, routes: routePending, protection: protPending });
  } else add('nimble', 'done', { written: (derived.summary?.keep || 0) + (protection?.summary?.keep || 0) });

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
  else if (watched.failing) {
    add('verify', 'action', { ok: watched.ok, total: watched.total }, { code: 'not-arriving' });
  } else {
    // Confirmed, and when. A probe from three days ago is not a statement
    // about now, so an old result is reported as stale rather than as a tick —
    // a green step that stopped being true is worse than no step.
    const ageMin = watched.at ? Math.round((Date.now() - new Date(watched.at).getTime()) / 60000) : null;
    if (ageMin != null && ageMin > 24 * 60) {
      add('verify', 'action', { ok: watched.ok, total: watched.total, ageHours: Math.round(ageMin / 60) },
          { code: 'stale' });
    } else {
      add('verify', 'done', { ok: watched.ok, total: watched.total, ageMin });
    }
  }

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
