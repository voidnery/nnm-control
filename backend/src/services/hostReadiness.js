// What a machine needs for the job it has been given, and what it is missing.
//
// The panel is about to start installing software and opening public ports —
// a class of action it has never taken. Everything it has written so far went
// into somebody else's API, where a wrong call is refused. A wrong apt-get is
// not refused; it happens.
//
// So the shape here is: find out first, and separate finding out from doing.
// This file only decides what a purpose requires and reads back what a machine
// reports. Nothing in it changes anything.
//
// The requirements differ by purpose, which is the point of having named it:
//
//   nimble      — a media server. Nginx is not wanted and its presence on port
//                 80 is a conflict, not a feature.
//   nimble-cdn  — the same machine, also a node in a network. Playback ports
//                 must be reachable and TLS is wanted if LL-HLS is.
//   gateway     — no media server at all. Nginx, a resolver and a certificate,
//                 and ports 80 and 443 free before any of it.

export const PURPOSES = ['nimble', 'nimble-cdn', 'gateway'];

// Each requirement says what it is for, because a checklist without reasons is
// a checklist somebody overrides.
const REQUIREMENTS = {
  nimble: [
    { id: 'nimble-running', why: 'it is a media server' },
  ],
  'nimble-cdn': [
    { id: 'nimble-running', why: 'it is a media server' },
    { id: 'playback-port-open', why: 'edges and viewers fetch playlists from it' },
  ],
  gateway: [
    // Deliberately first: everything else is pointless if something already
    // answers on the ports, and finding that out after installing nginx means
    // a broken service on somebody else's machine.
    { id: 'ports-free', why: 'nginx cannot bind a port something else holds' },
    { id: 'nginx-installed', why: 'it terminates TLS and forwards to an edge' },
    { id: 'tls-cert', why: 'viewers reach it by name over https' },
    { id: 'resolver', why: 'it resolves edge names at request time, not at start-up' },
  ],
};

export const requirementsFor = (purpose) => REQUIREMENTS[purpose] || REQUIREMENTS.nimble;

// A machine's own report against what its purpose asks for.
//
// `unknown` is a first-class answer and not folded into `missing`: an agent
// too old to be asked, or one that could not look, is a different situation
// from a machine that genuinely lacks something — and only one of the two is
// fixed by installing anything.
export function readiness({ purpose = 'nimble', report = null, agentVersion = 0 } = {}) {
  const required = requirementsFor(purpose);
  if (!report) {
    return {
      purpose, ready: false,
      // Named rather than implied. "The panel has not asked" reads as "the
      // machine is not ready" only if nobody says otherwise.
      code: agentVersion && agentVersion < PREPARE_MIN_AGENT ? 'agent-too-old' : 'not-checked',
      need: PREPARE_MIN_AGENT,
      have: agentVersion || null,
      items: required.map(r => ({ ...r, state: 'unknown' })),
    };
  }

  const items = required.map(r => {
    const v = report[r.id];
    return { ...r, state: v === true ? 'ok' : v === false ? 'missing' : 'unknown', detail: report[`${r.id}:detail`] || null };
  });
  const missing = items.filter(i => i.state === 'missing');
  const unknown = items.filter(i => i.state === 'unknown');

  return {
    purpose,
    ready: missing.length === 0 && unknown.length === 0,
    code: missing.length ? 'incomplete' : unknown.length ? 'partly-unknown' : 'ready',
    items, missing: missing.map(i => i.id), unknown: unknown.map(i => i.id),
  };
}

// The agent has to be new enough to be asked at all. An older one answers 404
// and the panel would report a machine as unready because it could not ask —
// the same conflation this file exists to avoid.
export const PREPARE_MIN_AGENT = 21;

// Whether a purpose can be changed to another without the panel doing damage.
// Turning a working media server into a gateway is not a field edit: something
// is serving video on it.
export function purposeChangeWarnings(from, to, { nimbleRunning = null } = {}) {
  if (from === to) return [];
  const out = [];
  if (to === 'gateway' && nimbleRunning) {
    out.push({ code: 'nimble-still-running', severity: 'block' });
  }
  if (from === 'gateway' && to !== 'gateway') {
    out.push({ code: 'was-a-gateway', severity: 'warn' });
  }
  if (from === 'nimble-cdn' && to === 'nimble') {
    // The routes stay where they are; the panel simply stops managing them.
    out.push({ code: 'leaves-network', severity: 'warn' });
  }
  return out;
}
