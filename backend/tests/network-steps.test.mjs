// The six steps, iter21 m4.
//
// The panel had all of this on six equal tabs, which answers "where is that
// setting" and never "what do I do next". These checks are about the states:
// a tick has to mean the thing is true, and the three ways of not being done
// have to stay apart — nothing here yet, something is wrong, and we could not
// find out are three different sentences and three different next actions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { networkSteps, STEP_IDS } from '../src/services/networkSteps.js';
import { carriedApplications } from '../src/services/carriedApplications.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const SERVERS = [
  { _id: 'o', name: 'selectel(24/7)' }, { _id: 'e2', name: 'RU-2' }, { _id: 'e3', name: 'RU-3' },
];
const NET = (over = {}) => ({
  name: 'prod',
  nodes: [
    { id: 'n-o', role: 'origin', server: 'o', upstream: [], enabled: true },
    { id: 'n-2', role: 'edge', server: 'e2', upstream: ['n-o'], enabled: true },
  ],
  gateway: { mode: 'direct', policy: 'nearest' },
  ...over,
});
const CH = [{ application: 'test2', stream: 'main' }];

// Built by the real function rather than hand-written here.
//
// The membership of a network is one computation, in
// `services/carriedApplications.js`. A fixture shaped by hand would let these
// checks agree with a `carried` object the panel can never produce — which is
// the failure mode this whole change removes, reintroduced in the tests.
const carried = (channels = [], applications = []) =>
  carriedApplications({ network: { applications }, channels });

// A network that has declared what it carries. This is the finished state now:
// carrying an application only because a channel points at it is `action`, not
// `done`, because nothing records the membership and so nothing can answer
// whether a new stream on the origin belongs to this network.
const DECLARED = carried(CH, [{ name: 'test2' }]);
const SYNCED = { inSync: true, blocking: [], summary: { create: 0, update: 0, keep: 2 } };
const step = (r, id) => r.steps.find(s => s.id === id);

console.log('\nTHE STEPS ARE THE JOB, IN ORDER:');

check('there are six, and they are the six', () => {
  const r = networkSteps({ network: NET(), servers: SERVERS, carried: DECLARED, derived: SYNCED });
  assert.deepEqual(r.steps.map(s => s.id), STEP_IDS);
});

check('a fully set-up network reads as done', () => {
  // Five steps now, not six: the roles and the upstreams are one table and
  // were two cards showing it twice.
  const r = networkSteps({
    network: NET(), servers: SERVERS, carried: DECLARED, derived: SYNCED,
    watched: { total: 1, ok: 1, failing: 0 },
  });
  assert.equal(r.done, 5, JSON.stringify(r.steps.map(s => [s.id, s.state])));
  assert.equal(r.next, null);
});

console.log('\nTHREE WAYS OF NOT BEING DONE, KEPT APART:');

check('an empty network is empty, not broken', () => {
  // Nothing has been done yet. Painting that as a fault greets a new operator
  // with a page of problems they created by opening it.
  // `carried([])` is a computed empty membership, which is a different
  // statement from not having computed one at all — see the `unknown` check
  // below. Both had the same answer while the step counted channel records.
  const r = networkSteps({ network: { nodes: [], gateway: {} }, servers: SERVERS,
                           carried: carried([]) });
  assert.equal(step(r, 'topology').state, 'empty');
  assert.equal(step(r, 'channels').state, 'empty');
});

check('a declared application with no channel record is still work to do', () => {
  // The case that was wrong and that nothing covered: step three was moved
  // onto applications and step four was left counting channel records, so a
  // network that declared an application and had no channels read "nothing to
  // configure" while routes were being planned for it.
  //
  // Found by a diversion that changed no test — which meant the tests missed
  // the wiring, not that the code was safe.
  const declaredOnly = carried([], [{ name: 'feed1' }]);
  const pending = { inSync: false, blocking: [], summary: { create: 2, update: 0, keep: 0 } };
  const r = networkSteps({ network: NET(), servers: SERVERS, carried: declaredOnly, derived: pending });
  assert.equal(step(r, 'channels').state, 'done');
  assert.equal(step(r, 'nimble').state, 'action',
    JSON.stringify(r.steps.map(s => [s.id, s.state])));
  assert.equal(step(r, 'nimble').summary.pending, 2);
});

check('a network that declares nothing has nothing to configure', () => {
  // The other side of it, so the check above cannot pass by always saying
  // `action`.
  const r = networkSteps({ network: NET(), servers: SERVERS, carried: carried([]),
                           derived: { inSync: false, blocking: [], summary: { create: 2, update: 0, keep: 0 } } });
  assert.equal(step(r, 'nimble').state, 'empty');
});

check('a membership nobody computed is unknown, not empty', () => {
  // "This network carries nothing" and "we did not work out what it carries"
  // are fixed by different actions: one by declaring an application, the other
  // by looking at why the caller passed nothing.
  const r = networkSteps({ network: NET(), servers: SERVERS, derived: SYNCED });
  assert.equal(step(r, 'channels').state, 'unknown');
});

check('a network missing an origin needs a decision, not a nudge', () => {
  const noOrigin = NET({ nodes: [{ id: 'n-2', role: 'edge', server: 'e2', upstream: [], enabled: true }] });
  const r = networkSteps({ network: noOrigin, servers: SERVERS });
  assert.equal(step(r, 'topology').state, 'action');
  assert.equal(step(r, 'topology').code, 'no-origin');
});

check('a derived plan the panel could not read is unknown, not empty', () => {
  // "We did not ask" and "there is nothing" lead to different next actions,
  // and only one of them is the operator's problem.
  const r = networkSteps({ network: NET(), servers: SERVERS, carried: DECLARED, derived: null });
  assert.equal(step(r, 'nimble').state, 'unknown');
});

console.log('\nA TICK MEANS THE THING IS TRUE:');

check('nothing to derive is not "set up"', () => {
  // A network with no channels derives nothing, which is trivially in sync.
  // Ticking it would put a green mark on a network that delivers nothing.
  const r = networkSteps({ network: NET(), servers: SERVERS, carried: carried([]), derived: SYNCED });
  assert.equal(step(r, 'nimble').state, 'empty');
});

check('verification is never done on configuration alone', () => {
  // Everything above can be right while nothing arrives. That is the entire
  // reason the watch probe exists.
  const r = networkSteps({ network: NET(), servers: SERVERS, carried: DECLARED, derived: SYNCED });
  assert.equal(step(r, 'verify').state, 'empty');
  assert.notEqual(step(r, 'verify').state, 'done');
});

check('a failing probe is an action even when everything is configured', () => {
  const r = networkSteps({
    network: NET(), servers: SERVERS, carried: DECLARED, derived: SYNCED,
    watched: { total: 2, ok: 1, failing: 1 },
  });
  assert.equal(step(r, 'verify').state, 'action');
  assert.equal(step(r, 'verify').code, 'not-arriving');
});

check('a confirmed delivery turns the step green', () => {
  // It never could: nothing remembered the probe, so the step asked forever.
  const r = networkSteps({
    network: NET(), servers: SERVERS, carried: DECLARED, derived: SYNCED,
    watched: { total: 3, ok: 3, failing: 0, at: new Date() },
  });
  assert.equal(step(r, 'verify').state, 'done');
});

check('a confirmation old enough to have stopped being true is not a tick', () => {
  // A green step that was true last Tuesday is worse than an empty one: it
  // answers a question about now with an answer about then.
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const r = networkSteps({
    network: NET(), servers: SERVERS, carried: DECLARED, derived: SYNCED,
    watched: { total: 3, ok: 3, failing: 0, at: old },
  });
  assert.equal(step(r, 'verify').state, 'action');
  assert.equal(step(r, 'verify').code, 'stale');
  assert.ok(step(r, 'verify').summary.ageHours >= 70);
});

console.log('\nWHAT IS NOT ASKED:');

check('an origin is not asked what it takes content from', () => {
  // It is fed by whatever publishes into it — an encoder, vMix, an SRT caller
  // — none of which the panel models. Asking would demand an action that does
  // not exist, which it did on the overview page until v0.70.1.
  const r = networkSteps({ network: NET(), servers: SERVERS, carried: DECLARED, derived: SYNCED });
  assert.equal(step(r, 'topology').state, 'done');
  assert.equal(step(r, 'topology').summary.total, 1, 'the origin was counted as needing an upstream');
});

check('an unwired edge is named as such', () => {
  const loose = NET({ nodes: [
    { id: 'n-o', role: 'origin', server: 'o', upstream: [], enabled: true },
    { id: 'n-2', role: 'edge', server: 'e2', upstream: [], enabled: true },
  ] });
  const r = networkSteps({ network: loose, servers: SERVERS });
  assert.equal(step(r, 'topology').state, 'action');
  assert.equal(step(r, 'topology').code, 'unwired');
});

check('"straight to the edge" is an answer, not an absence', () => {
  // It is the default, it works, and it needs no machine. Only a gateway mode
  // with nothing behind it is a problem.
  const r = networkSteps({ network: NET(), servers: SERVERS, carried: DECLARED, derived: SYNCED });
  assert.equal(step(r, 'links').state, 'done');
  const halfGw = NET({ gateway: { mode: 'redirect', policy: 'nearest', node: null } });
  const r2 = networkSteps({ network: halfGw, servers: SERVERS, carried: DECLARED, derived: SYNCED });
  assert.equal(step(r2, 'links').state, 'action');
});

check('protection waiting to be written keeps the Nimble step unfinished', () => {
  // The step said "all set up" while a channel's token protection sat
  // unwritten: everything visible was green and the stream was open to
  // anybody. Both halves count, and the row says which is which.
  const r = networkSteps({
    network: NET(), servers: SERVERS, carried: DECLARED, derived: SYNCED,
    protection: { inSync: false, blocking: [], summary: { create: 2, update: 0, keep: 0 } },
  });
  const n = step(r, 'nimble');
  assert.equal(n.state, 'action');
  assert.equal(n.summary.protection, 2);
  assert.equal(n.summary.routes, 0, 'the routes are in sync and should not be counted as pending');
});

check('protection blocked is its own code, not "pending"', () => {
  // A different fault from routes blocked, and the more dangerous one: the
  // routes work, the stream is delivered, and it is delivered to anybody.
  const r = networkSteps({
    network: NET(), servers: SERVERS, carried: DECLARED, derived: SYNCED,
    protection: { inSync: false, blocking: [{ code: 'http-origin-defeats-protection' }], summary: {} },
  });
  assert.equal(step(r, 'nimble').code, 'protection-blocked');
});

console.log('\nWHERE TO GO NEXT:');

check('the first step wanting attention is offered', () => {
  const loose = NET({ nodes: [
    { id: 'n-o', role: 'origin', server: 'o', upstream: [], enabled: true },
    { id: 'n-2', role: 'edge', server: 'e2', upstream: [], enabled: true },
  ] });
  const r = networkSteps({ network: loose, servers: SERVERS, carried: carried([]), derived: SYNCED });
  assert.equal(r.next, 'topology', 'an action outranks an empty step');
});

check('with nothing wrong, the first unstarted step is offered', () => {
  const r = networkSteps({ network: NET(), servers: SERVERS, carried: carried([]), derived: SYNCED });
  assert.equal(r.next, 'channels');
});

console.log('\nTHE PAGE IS A LIST OF STEPS:');

const FRONT = new URL('../../frontend/src/', import.meta.url);
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const setup = strip(readFileSync(new URL('components/NetworkSetup.jsx', FRONT), 'utf8'));
const net = strip(readFileSync(new URL('components/DeliveryNetworkPanel.jsx', FRONT), 'utf8'));
const dict = readFileSync(new URL('i18n.jsx', FRONT), 'utf8');

check('every step is rendered, in the order the service defines', () => {
  // Bound to STEP_IDS rather than to a literal list. The page and the service
  // disagreeing about which steps exist is how a card opens onto nothing, and
  // a hard-coded list in the assertion just moves the disagreement here.
  const m = setup.match(/\{\[((?:\s*'[a-z]+',?)+)\]\.map\(\(id, i\)/);
  assert.ok(m, 'the steps are not rendered as one ordered list');
  const rendered = [...m[1].matchAll(/'([a-z]+)'/g)].map(x => x[1]);
  assert.deepEqual(rendered, STEP_IDS, 'the page renders a different set of steps than the service computes');
});

check('every step has something inside it', () => {
  // A step that opens onto nothing is worse than no step: it looks like a
  // feature that has not been built.
  for (const id of STEP_IDS) {
    assert.ok(new RegExp(`${id}:`).test(net), `the ${id} step has no content slotted into it`);
  }
});

check('one step is open at a time', () => {
  // Which is what stops the page growing downwards: the panels were never too
  // long, they were all on screen at once and each grew when used.
  assert.ok(/setOpen\(o => \(o === id \? '' : id\)\)/.test(setup), 'steps do not toggle');
  assert.ok(/open === id/.test(setup), 'more than one step can be open');
});

check('the page opens on what needs attention, once', () => {
  // And then leaves the operator alone: reopening a step under their cursor
  // because the data changed is the panel arguing with them.
  assert.ok(/if \(!steps \|\| open\) return;/.test(setup), 'the open step is reset on every update');
  assert.ok(/steps\.next/.test(setup));
});

check('every state of every step has a sentence, in both languages', () => {
  for (const id of STEP_IDS) {
    assert.equal((dict.match(new RegExp(`'step\\.${id}':`, 'g')) || []).length, 2, `step.${id}`);
    assert.equal((dict.match(new RegExp(`'step\\.${id}\\.done':`, 'g')) || []).length, 2, `step.${id}.done`);
  }
});

console.log(failures ? `\n${failures} step check(s) failed` : '\nall step checks passed');
process.exit(failures ? 1 : 0);
