// What a machine is for, and everything that follows.
//
// This model exists because six places were deriving it separately and
// disagreeing. So the checks here are mostly about *agreement*: the backend
// with itself, the frontend copy with the backend, and the button with the
// route that refuses it.
//
// The failure it was written after: the privileged helper was opened to media
// servers in the backend and the page that offers it still asked
// `purpose === 'gateway'`. For two versions the only way an operator could get
// a helper onto a delivery media server was to relabel it as an edge-proxy —
// telling the panel something false about the machine, to work around the
// panel.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PURPOSES, HELPER_PURPOSES, capabilities, helperState, canChangeSystem, helperReported,
} from '../src/services/serverCapabilities.js';
import { privilegedEligibility, profileFor, PROFILES } from '../src/services/privilegedHelper.js';

const here = dirname(fileURLToPath(import.meta.url));
const frontendCaps = readFileSync(
  join(here, '..', '..', 'frontend', 'src', 'lib', 'capabilities.js'), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('Server capabilities\n');

// --- the three kinds --------------------------------------------------------

check('there are three kinds and every one of them has an answer', () => {
  assert.deepEqual(PURPOSES, ['nimble', 'nimble-cdn', 'gateway']);
  for (const p of PURPOSES) {
    const c = capabilities({ purpose: p });
    assert.equal(typeof c.runsNimble, 'boolean');
    assert.equal(typeof c.servesPlayback, 'boolean');
    assert.equal(typeof c.helper.needed, 'boolean');
    assert.equal(typeof c.llhls.applicable, 'boolean');
  }
});

check('a processing media server serves nobody and needs nothing', () => {
  const c = capabilities({ purpose: 'nimble' });
  assert.equal(c.runsNimble, true);
  assert.equal(c.servesPlayback, false);
  assert.equal(c.tls.needed, false);
  assert.equal(c.helper.needed, false,
    'system access would be bought for a machine with nothing to do with it');
  assert.equal(c.llhls.applicable, false);
  assert.equal(c.llhls.reason, 'this-machine-does-not-serve-viewers');
});

check('a delivery media server is the one LL-HLS is about', () => {
  const c = capabilities({ purpose: 'nimble-cdn' });
  assert.equal(c.llhls.applicable, true);
  assert.equal(c.tls.target, 'nimble-conf');
  assert.equal(c.helper.profile, 'edge');
});

check('a gateway serves viewers and has no Nimble to configure', () => {
  const c = capabilities({ purpose: 'gateway' });
  assert.equal(c.runsNimble, false);
  assert.equal(c.servesPlayback, true);
  assert.equal(c.tls.target, 'nginx');
  assert.equal(c.llhls.applicable, false);
  assert.equal(c.llhls.reason, 'no-nimble-on-this-machine');
  assert.equal(c.helper.profile, 'gateway');
});

check('an unknown purpose falls to the most limited kind', () => {
  // Not to the most capable one. A machine whose purpose is missing or
  // misspelt must not thereby acquire the ability to be changed.
  const c = capabilities({ purpose: 'something-else' });
  assert.equal(c.purpose, 'nimble');
  assert.equal(c.helper.needed, false);
  assert.equal(c.llhls.applicable, false);
});

// --- the same answer everywhere ---------------------------------------------

check('the helper rule is one rule, not one per caller', () => {
  for (const p of PURPOSES) {
    const needed = capabilities({ purpose: p }).helper.needed;
    const eligible = privilegedEligibility({ purpose: p, agent: { enabled: true } });
    assert.equal(eligible.ok, needed,
      `capabilities and privilegedEligibility disagree about ${p}`);
  }
});

check('the profile a machine gets is the profile the helper installs', () => {
  for (const p of HELPER_PURPOSES) {
    assert.equal(profileFor(p), capabilities({ purpose: p }).helper.profile);
    assert.ok(PROFILES[profileFor(p)], `${p} maps to a profile that does not exist`);
  }
});

check('the frontend copy of the purpose rule matches the backend', () => {
  // The browser decides whether to draw a button before any request is made,
  // so it carries a copy. A copy is a thing that drifts, and this drift is
  // exactly what hid the installer for two versions.
  const m = frontendCaps.match(/export const HELPER_PURPOSES = \[([^\]]*)\]/);
  assert.ok(m, 'the frontend has no HELPER_PURPOSES');
  const front = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort();
  assert.deepEqual(front, [...HELPER_PURPOSES].sort(),
    'the page would offer the helper on a different set of machines than the API accepts');
});

check('the frontend agrees about which machines LL-HLS is for', () => {
  const m = frontendCaps.match(/export const LLHLS_PURPOSES = \[([^\]]*)\]/);
  assert.ok(m, 'the frontend has no LLHLS_PURPOSES');
  const front = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort();
  const back = PURPOSES.filter(p => capabilities({ purpose: p }).llhls.applicable).sort();
  assert.deepEqual(front, back,
    'the list would show a different set of machines than the API returns');
});

// --- three values, and the third permits nothing ----------------------------

check('the helper is read from the record the helper writes', () => {
  // `helper.seen` is the field. The first version of this read
  // `server.agent.privileged`, which the schema does not have, so every
  // machine in the fleet reported "never told us" and installing a helper by
  // hand changed nothing the panel could see. Fourth instance in this project
  // of reading a field off an object that does not carry it.
  assert.equal(helperReported({ helper: { seen: true } }), true);
  assert.equal(helperReported({ agent: { lastContactAt: new Date() } }), false);
  assert.equal(helperReported({}), null);
  // And the field that never existed must not resurrect a wrong answer.
  assert.equal(helperReported({ agent: { privileged: true } }), null,
    'a field nothing sets is being trusted again');
});

check('unknown is its own state and is not absence', () => {
  const s = { purpose: 'nimble-cdn', agent: { enabled: true } };
  assert.equal(helperState(s), 'unknown');
  assert.equal(helperState({ ...s, agent: { enabled: true, lastContactAt: new Date() } }), 'missing');
  assert.equal(helperState({ ...s, helper: { seen: true } }), 'installed');
  assert.equal(helperState({ purpose: 'nimble', agent: { enabled: true } }), 'not-needed');
});

check('the panel and the servers list agree, because it is one function', () => {
  // routes/servers.js had this rule written out by hand and the new code had
  // a second, different one. Now there is a function and the route calls it.
  const routes = readFileSync(join(here, '..', 'src', 'routes', 'servers.js'), 'utf8');
  assert.match(routes, /privileged: helperReported\(s\)/,
    'the servers list derives the helper state independently again');
});

check('unknown blocks a change exactly as absence does', () => {
  // The whole reason this function exists. The screen offered "write it and
  // restart Nimble" on a machine whose helper had never been reported, and the
  // refusal arrived as an HTTP 422 after the press.
  const base = { purpose: 'nimble-cdn', agent: { enabled: true } };
  assert.equal(canChangeSystem(base).ok, false);
  assert.equal(canChangeSystem(base).code, 'helper-state-unknown');
  assert.equal(canChangeSystem({ ...base, agent: { enabled: true, lastContactAt: new Date() } }).code,
    'helper-not-installed');
  assert.equal(canChangeSystem({ ...base, helper: { seen: true } }).ok, true);
});

check('a machine that needs no helper is refused for that reason, not for a missing one', () => {
  // Different problems have different fixes. "Install the helper" on a machine
  // that should never have one sends the operator to relabel it, which is how
  // this whole tangle started.
  const r = canChangeSystem({ purpose: 'nimble', agent: { enabled: true, lastContactAt: new Date() } });
  assert.equal(r.code, 'helper-not-applicable');
});

check('an agent that is switched off is named as that, before the helper', () => {
  const r = canChangeSystem({ purpose: 'nimble-cdn', agent: { enabled: false } });
  assert.equal(r.code, 'agent-not-enabled');
});

// --- the gateway mode has one home ------------------------------------------

check('the mode is declared to come from the network, not from a request', () => {
  assert.equal(capabilities({ purpose: 'gateway' }).gateway.modeFromNetwork, true);
});

check('the gateway wizard no longer sends a mode', () => {
  // It used to send whatever its own toggle held, defaulting to `redirect`, so
  // preparing a proxy gateway quietly rewrote it as a redirect one.
  const modal = readFileSync(
    join(here, '..', '..', 'frontend', 'src', 'components', 'GatewaySetupModal.jsx'), 'utf8');
  assert.ok(!/body:\s*\{[^}]*\bmode\b/.test(modal),
    'the setup dialog still puts a mode in its request body');
  assert.ok(!/setMode\(/.test(modal), 'the dialog still has a mode picker');
});

const servers = readFileSync(join(here, '..', 'src', 'routes', 'servers.js'), 'utf8');

check('the routes read the mode from the network instead of the body', () => {
  assert.ok(!/req\.body\?\.mode/.test(servers),
    'a gateway route still takes the mode from the request body');
  assert.match(servers, /gatewayModeOf/);
});

check('a gateway in no network is refused rather than defaulted to redirect', () => {
  assert.match(servers, /gateway-not-in-a-network/);
  assert.match(servers, /gateway-mode-conflict/,
    'two networks disagreeing about one machine would be silently resolved');
});

console.log(failures ? `\n${failures} capability check(s) failed` : '\nall capability checks passed');
process.exit(failures ? 1 : 0);
