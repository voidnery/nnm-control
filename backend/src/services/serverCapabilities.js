// What a machine is for, and what follows from it.
//
// This exists because the answer was being derived independently in six
// places, and they disagreed. The privileged helper was opened to media
// servers in v1.14.0 — in the backend. The page that offers it still asked
// `purpose === 'gateway'`, so on a media server the button was simply absent
// and the operator's only route to it was to relabel the machine as an
// edge-proxy, which is false. The LL-HLS screen filtered on "not a gateway"
// and listed fourteen machines including ones that process video and serve
// nobody. The gateway wizard asked for redirect-or-proxy, which the delivery
// network already decides.
//
// Every one of those is the same mistake: a screen deciding for itself what a
// machine can do. So it is decided once, here, and everything else reads it.
//
// ---------------------------------------------------------------------------
// The three kinds, as the operator names them
//
//   nimble       A media server. Processes, transcodes, originates. It runs
//                Nimble, and it is not part of delivery.
//
//   nimble-cdn   Nimble plus a role in a delivery network — mid or edge. It
//                serves playlists to viewers itself, which is why LL-HLS is
//                its question and nobody else's.
//
//   gateway      Delivery without Nimble: the edge-proxy or edge-redirect box.
//                nginx serves or redirects; there is no Nimble on it, so there
//                is no nimble.conf and no LL-HLS to configure.
//
// **Decided by purpose, by the operator's instruction.** The alternative —
// deriving it from membership in a delivery network — was considered and is
// not what was asked for. One consequence must be said out loud rather than
// discovered: a machine that really does serve viewers while labelled `nimble`
// will not be offered LL-HLS until its purpose is corrected. That is the
// filter working, not failing, and `selectel(24/7)` is exactly such a machine
// today.

export const PURPOSES = ['nimble', 'nimble-cdn', 'gateway'];

// Purposes whose work needs system changes, and therefore the privileged
// helper. Exported by name because the frontend carries a copy — it decides
// whether to show a button — and `backend/tests/capabilities.test.mjs` fails
// when the two disagree.
export const HELPER_PURPOSES = ['nimble-cdn', 'gateway'];

// Where TLS lives on each kind. Not the same file, not the same program, and
// the operator should never have to know which: they answer "how should the
// certificate be obtained", and this decides where it goes.
const TLS_TARGET = {
  'nimble': null,
  'nimble-cdn': 'nimble-conf',
  'gateway': 'nginx',
};

export function capabilities(server) {
  const purpose = PURPOSES.includes(server?.purpose) ? server.purpose : 'nimble';
  const runsNimble = purpose !== 'gateway';
  const servesPlayback = purpose !== 'nimble';
  const tlsTarget = TLS_TARGET[purpose];

  // The helper is offered because something needs it, never as a switch of its
  // own. On a media server that only processes, nothing does — and an
  // installer offered everywhere ends up everywhere.
  const helperNeeded = HELPER_PURPOSES.includes(purpose);

  return {
    purpose,
    runsNimble,
    servesPlayback,

    tls: {
      // `null` on a processing server: it has no viewers to protect, and
      // offering it a certificate would be offering it work with no result.
      target: tlsTarget,
      needed: tlsTarget !== null,
    },

    helper: {
      needed: helperNeeded,
      // Which of the two profiles. A gateway gets nginx, a webroot and the
      // ability to signal a process holding port 80; an edge gets /etc/nimble
      // and none of those.
      profile: helperNeeded ? (purpose === 'gateway' ? 'gateway' : 'edge') : null,
      reason: helperNeeded
        ? (purpose === 'gateway' ? 'nginx-and-certificate' : 'nimble-conf-and-certificate')
        : 'nothing-on-this-machine-needs-system-changes',
    },

    llhls: {
      // Nimble *and* delivery. A gateway has no Nimble to configure; a
      // processing server has nobody to deliver to.
      applicable: runsNimble && servesPlayback,
      reason: !runsNimble ? 'no-nimble-on-this-machine'
        : !servesPlayback ? 'this-machine-does-not-serve-viewers'
        : null,
    },

    gateway: {
      applicable: purpose === 'gateway',
      // The mode is a property of the delivery network, not of the machine and
      // not of whoever opened the wizard. It used to be read from the request
      // body with a silent default of `redirect`, so the wizard could disagree
      // with the network and nothing would say so.
      modeFromNetwork: true,
    },
  };
}

// The helper is on this machine, is not, or has never said.
//
// **Read from `helper.seen`, which is where it lives.** The first version of
// this read `server.agent.privileged` — a field the schema does not have, so
// it was `undefined` on every machine in the fleet and every one of them
// reported "never told us". A helper installed by hand made no difference,
// because nothing was looking at the record it writes.
//
// That is the fourth time in this project: reading a field off an object that
// does not carry it. `agent` from `/servers`, `gateway` from the networks
// list, `host` from a network node, and now this. It fails silently every
// time — `undefined` is a value, and code carries on with it.
//
// The rule itself is the one `routes/servers.js` had already worked out, moved
// here so that it is worked out once:
//
//   seen                     → installed
//   not seen, agent has been in touch → missing, because we would have heard
//   nothing has been in touch at all  → unknown
//
// Three values, and the third does not permit anything: the LL-HLS screen
// offered "write it and restart Nimble" on a machine in that state, and the
// refusal arrived as a 422 after the press.
export function helperReported(server) {
  if (server?.helper?.seen) return true;
  // The ordinary agent polls every ten seconds by default. If it has ever been
  // in touch and no helper has, the helper is not there — this is a
  // measurement, not an assumption.
  if (server?.agent?.lastContactAt) return false;
  return null;
}

export function helperState(server) {
  const caps = capabilities(server);
  if (!caps.helper.needed) return 'not-needed';
  const v = helperReported(server);
  if (v === true) return 'installed';
  if (v === false) return 'missing';
  return 'unknown';
}

// May the panel change this machine's system right now, and if not, why. One
// function so that a button, a route and an error message cannot disagree
// about it.
export function canChangeSystem(server) {
  const caps = capabilities(server);
  if (!caps.helper.needed) {
    return { ok: false, code: 'helper-not-applicable', purpose: caps.purpose };
  }
  if (!server?.agent?.enabled) return { ok: false, code: 'agent-not-enabled' };
  const state = helperState(server);
  if (state === 'installed') return { ok: true, profile: caps.helper.profile };
  return { ok: false, code: state === 'missing' ? 'helper-not-installed' : 'helper-state-unknown',
           profile: caps.helper.profile };
}
