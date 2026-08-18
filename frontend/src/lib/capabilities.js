// What a machine is for, on the browser's side.
//
// The authority is `backend/src/services/serverCapabilities.js`. This is a
// copy, because a button has to decide whether to render before any request is
// made, and `backend/tests/capabilities.test.mjs` fails when the two disagree.
//
// The copy is deliberately tiny: only the facts a screen needs to decide what
// to draw. Everything that decides what may actually happen stays on the
// server, where it cannot be edited by whoever is holding the browser.

// Purposes whose work needs system changes, and therefore the privileged
// helper. A machine that only processes video has no nginx to configure and no
// certificate to hold.
export const HELPER_PURPOSES = ['nimble-cdn', 'gateway'];

// Purposes that run Nimble *and* serve viewers. LL-HLS is their question and
// nobody else's: a gateway has no Nimble, a processing server has no viewers.
export const LLHLS_PURPOSES = ['nimble-cdn'];

export const purposeOf = (server) => server?.purpose || 'nimble';

export const needsHelper = (server) => HELPER_PURPOSES.includes(purposeOf(server));
export const llhlsApplies = (server) => LLHLS_PURPOSES.includes(purposeOf(server));

// Three-valued, and the third value permits nothing.
//
// `null` means the machine has never reported. That is honest in a report and
// dangerous on a button: the LL-HLS screen offered "write it and restart
// Nimble" on a machine whose helper state was unknown, and the refusal arrived
// after the press.
export function helperState(server) {
  if (!needsHelper(server)) return 'not-needed';
  const v = server?.privileged ?? server?.agent?.privileged;
  if (v === true) return 'installed';
  if (v === false) return 'missing';
  return 'unknown';
}

export const canChangeSystem = (server) => helperState(server) === 'installed';
