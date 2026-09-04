// Which applications this network carries — one answer, in one place.
//
// There were two, and they were computed from different data:
//
//   POST /cdn/networks/{id}/plan|apply|state   took the list from the request
//     body, which the browser had computed as the distinct applications of the
//     channel records it happened to be showing;
//   GET  /channels/networks/{id}/derived       read `Channel.find` itself.
//
// Same question, two computations, and nothing held them equal. Third instance
// in this project of a rule with two consumers reading different inputs — the
// audit log cost 23.8 GB of a disk for exactly that shape.
//
// Underneath the duplication is the larger problem it grew out of: **a network
// did not record what it carries at all.** "Delivered by this network" existed
// only as a side effect of somebody having created a channel record, so the
// question "a stream appeared on the origin — does this network deliver it?"
// had no representation in the data to answer from. A re-streaming route is
// already per application (`/app/` → `origin:port/app/`), so a new stream in a
// carried application is delivered with no action at all — but only once the
// application is something the network knows it carries.
//
// So the network declares its applications, and this function is the only
// place that says what the set is.
//
// UNION, NOT REPLACEMENT. A declaration that silently dropped an application a
// channel points at would stop planning routes for a stream that is being
// delivered today. So an application counts as carried when the network
// declares it *or* a channel points at it, and every entry says which — the
// operator sees "this is delivered because a channel points at it, and the
// network does not declare it" rather than a merged list that hides the
// difference.

// Slashes only. NOT `.trim()`.
//
// `NimbleGER-1` carries an application whose name begins with a tab —
// `\tblast_feed_cs`, recorded in docs/STATE.md. Application names go into
// playback paths, so stripping the whitespace produces a route and a link to
// an application that does not exist, while the origin publishes another. The
// two normalisers that were already here — `deliveryPlan.js` and
// `derivePlan.js` — strip slashes and nothing else; this one added `.trim()`
// and would have silently renamed that application on the way in.
//
// Exported because there were three copies of this within one change, which is
// the drift the whole change exists to remove.
export const appName = (s) => String(s ?? '').replace(/^\/+|\/+$/g, '');

// Whitespace-only is not a name; whitespace-prefixed is somebody's real
// application. The difference matters and this is where it is made.
export const isName = (s) => appName(s).trim().length > 0;

const trim = appName;

// The set, and where each member came from.
//
// `planned` is the one field the planner reads. Everything else exists so a
// screen can explain the set rather than assert it.
export function carriedApplications({ network, channels = [] }) {
  const byName = new Map();

  const touch = (name) => {
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        declared: false,     // the network says it carries this
        disabled: false,     // …and has since switched it off
        channels: 0,         // channel records pointing at it
        streams: [],         // their stream names, for the screen
      });
    }
    return byName.get(name);
  };

  for (const a of network?.applications || []) {
    const name = trim(a?.name);
    if (!isName(name)) continue;
    const e = touch(name);
    if (a.enabled === false) e.disabled = true;
    else e.declared = true;
  }

  for (const c of channels) {
    const name = trim(c?.application);
    if (!isName(name)) continue;
    const e = touch(name);
    e.channels += 1;
    if (c.stream) e.streams.push(String(c.stream));
  }

  const list = [...byName.values()].map(e => ({
    ...e,
    // Declared wins over disabled only when both were written, which cannot
    // happen through the API — but a hand-edited document should not silently
    // become one or the other.
    planned: e.declared || (!e.disabled && e.channels > 0),
    // Named states rather than a pair of booleans a screen has to interpret.
    state: e.declared ? (e.channels ? 'declared' : 'declared-only')
         : e.disabled ? (e.channels ? 'disabled-with-channels' : 'disabled')
         : 'undeclared',
  })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    list,
    // What the planner uses. Nothing else may compute this.
    names: list.filter(e => e.planned).map(e => e.name),
    // Carried only because a channel points at it. The migration path: the
    // screen offers to declare these, and until somebody does, delivery is
    // unchanged.
    undeclared: list.filter(e => e.state === 'undeclared').map(e => e.name),
    // Switched off in the network while channels still point at it. Not
    // resolved here in either direction: routes already written are not
    // removed by an apply, so the consequence is that the plan stops covering
    // it — which is a thing to say, not to decide quietly.
    conflicts: list.filter(e => e.state === 'disabled-with-channels').map(e => e.name),
  };
}
