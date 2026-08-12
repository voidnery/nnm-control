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
const SYNCED = { inSync: true, blocking: [], summary: { create: 0, update: 0, keep: 2 } };
const step = (r, id) => r.steps.find(s => s.id === id);

console.log('\nTHE STEPS ARE THE JOB, IN ORDER:');

check('there are six, and they are the six', () => {
  const r = networkSteps({ network: NET(), servers: SERVERS, channels: CH, derived: SYNCED });
  assert.deepEqual(r.steps.map(s => s.id), STEP_IDS);
});

check('a fully set-up network reads as done', () => {
  const r = networkSteps({
    network: NET(), servers: SERVERS, channels: CH, derived: SYNCED,
    watched: { total: 1, ok: 1, failing: 0 },
  });
  assert.equal(r.done, 6, JSON.stringify(r.steps.map(s => [s.id, s.state])));
  assert.equal(r.next, null);
});

console.log('\nTHREE WAYS OF NOT BEING DONE, KEPT APART:');

check('an empty network is empty, not broken', () => {
  // Nothing has been done yet. Painting that as a fault greets a new operator
  // with a page of problems they created by opening it.
  const r = networkSteps({ network: { nodes: [], gateway: {} }, servers: SERVERS });
  assert.equal(step(r, 'members').state, 'empty');
  assert.equal(step(r, 'channels').state, 'empty');
});

check('a network missing an origin needs a decision, not a nudge', () => {
  const noOrigin = NET({ nodes: [{ id: 'n-2', role: 'edge', server: 'e2', upstream: [], enabled: true }] });
  const r = networkSteps({ network: noOrigin, servers: SERVERS });
  assert.equal(step(r, 'members').state, 'action');
  assert.equal(step(r, 'members').code, 'no-origin');
});

check('a derived plan the panel could not read is unknown, not empty', () => {
  // "We did not ask" and "there is nothing" lead to different next actions,
  // and only one of them is the operator's problem.
  const r = networkSteps({ network: NET(), servers: SERVERS, channels: CH, derived: null });
  assert.equal(step(r, 'nimble').state, 'unknown');
});

console.log('\nA TICK MEANS THE THING IS TRUE:');

check('nothing to derive is not "set up"', () => {
  // A network with no channels derives nothing, which is trivially in sync.
  // Ticking it would put a green mark on a network that delivers nothing.
  const r = networkSteps({ network: NET(), servers: SERVERS, channels: [], derived: SYNCED });
  assert.equal(step(r, 'nimble').state, 'empty');
});

check('verification is never done on configuration alone', () => {
  // Everything above can be right while nothing arrives. That is the entire
  // reason the watch probe exists.
  const r = networkSteps({ network: NET(), servers: SERVERS, channels: CH, derived: SYNCED });
  assert.equal(step(r, 'verify').state, 'empty');
  assert.notEqual(step(r, 'verify').state, 'done');
});

check('a failing probe is an action even when everything is configured', () => {
  const r = networkSteps({
    network: NET(), servers: SERVERS, channels: CH, derived: SYNCED,
    watched: { total: 2, ok: 1, failing: 1 },
  });
  assert.equal(step(r, 'verify').state, 'action');
  assert.equal(step(r, 'verify').code, 'not-arriving');
});

console.log('\nWHAT IS NOT ASKED:');

check('an origin is not asked what it takes content from', () => {
  // It is fed by whatever publishes into it — an encoder, vMix, an SRT caller
  // — none of which the panel models. Asking would demand an action that does
  // not exist, which it did on the overview page until v0.70.1.
  const r = networkSteps({ network: NET(), servers: SERVERS, channels: CH, derived: SYNCED });
  assert.equal(step(r, 'upstreams').state, 'done');
  assert.equal(step(r, 'upstreams').summary.total, 1, 'the origin was counted as needing an upstream');
});

check('an unwired edge is named as such', () => {
  const loose = NET({ nodes: [
    { id: 'n-o', role: 'origin', server: 'o', upstream: [], enabled: true },
    { id: 'n-2', role: 'edge', server: 'e2', upstream: [], enabled: true },
  ] });
  const r = networkSteps({ network: loose, servers: SERVERS });
  assert.equal(step(r, 'upstreams').state, 'action');
  assert.equal(step(r, 'upstreams').code, 'unwired');
});

check('"straight to the edge" is an answer, not an absence', () => {
  // It is the default, it works, and it needs no machine. Only a gateway mode
  // with nothing behind it is a problem.
  const r = networkSteps({ network: NET(), servers: SERVERS, channels: CH, derived: SYNCED });
  assert.equal(step(r, 'links').state, 'done');
  const halfGw = NET({ gateway: { mode: 'redirect', policy: 'nearest', node: null } });
  const r2 = networkSteps({ network: halfGw, servers: SERVERS, channels: CH, derived: SYNCED });
  assert.equal(step(r2, 'links').state, 'action');
});

console.log('\nWHERE TO GO NEXT:');

check('the first step wanting attention is offered', () => {
  const loose = NET({ nodes: [
    { id: 'n-o', role: 'origin', server: 'o', upstream: [], enabled: true },
    { id: 'n-2', role: 'edge', server: 'e2', upstream: [], enabled: true },
  ] });
  const r = networkSteps({ network: loose, servers: SERVERS, channels: [], derived: SYNCED });
  assert.equal(r.next, 'upstreams', 'an action outranks an empty step');
});

check('with nothing wrong, the first unstarted step is offered', () => {
  const r = networkSteps({ network: NET(), servers: SERVERS, channels: [], derived: SYNCED });
  assert.equal(r.next, 'channels');
});

console.log('\nTHE PAGE IS A LIST OF STEPS:');

const FRONT = new URL('../../frontend/src/', import.meta.url);
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const setup = strip(readFileSync(new URL('components/NetworkSetup.jsx', FRONT), 'utf8'));
const net = strip(readFileSync(new URL('components/DeliveryNetworkPanel.jsx', FRONT), 'utf8'));
const dict = readFileSync(new URL('i18n.jsx', FRONT), 'utf8');

check('all six steps are rendered, in order', () => {
  const listed = setup.match(/\['members', 'upstreams', 'channels', 'nimble', 'links', 'verify'\]/);
  assert.ok(listed, 'the steps are not rendered as one ordered list');
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
