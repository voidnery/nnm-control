// What a machine needs for the job it has, iter23 m1.
//
// The panel is about to start installing software and opening public ports —
// a class of action it has never taken. Everything written so far went into
// somebody else's API, where a wrong call is refused. A wrong apt-get is not
// refused; it happens.
//
// So finding out is separated from doing, and these checks are entirely about
// the finding out: what each purpose actually requires, and the difference
// between a machine that lacks something and one nobody has asked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readiness, requirementsFor, purposeChangeWarnings, PURPOSES, PREPARE_MIN_AGENT }
  from '../src/services/hostReadiness.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

console.log('\nA PURPOSE DECIDES WHAT IS ASKED:');

check('a gateway is not asked whether Nimble is running', () => {
  // There is no media server on it. Half of what the panel checks about a
  // server is meaningless there, and reporting a gateway as a broken Nimble
  // host is how a correct machine looks broken.
  const ids = requirementsFor('gateway').map(r => r.id);
  assert.ok(!ids.includes('nimble-running'));
});

check('a media server is not asked for nginx', () => {
  // Nginx on a Nimble box holding port 80 is a conflict, not a feature.
  assert.ok(!requirementsFor('nimble').map(r => r.id).includes('nginx-installed'));
});

check('ports are checked before anything is proposed for a gateway', () => {
  // Installing nginx where something already holds 80 produces a broken
  // service rather than an error, and finding that out afterwards means
  // having broken somebody else's machine.
  assert.equal(requirementsFor('gateway')[0].id, 'ports-free');
});

check('every requirement says what it is for', () => {
  // A checklist without reasons is a checklist somebody overrides.
  for (const p of PURPOSES) {
    for (const r of requirementsFor(p)) assert.ok(r.why, `${p}/${r.id} has no reason`);
  }
});

console.log('\nNOT ASKED IS NOT MISSING:');

check('a machine nobody has asked is "not checked"', () => {
  const r = readiness({ purpose: 'gateway' });
  assert.equal(r.ready, false);
  assert.equal(r.code, 'not-checked');
  assert.ok(r.items.every(i => i.state === 'unknown'));
});

check('an agent too old to be asked says so, and names the version', () => {
  // Otherwise the panel reports a machine as unready because it could not ask,
  // and somebody goes looking for a fault on a machine that has none.
  const r = readiness({ purpose: 'gateway', agentVersion: 20 });
  assert.equal(r.code, 'agent-too-old');
  assert.equal(r.need, PREPARE_MIN_AGENT);
  assert.equal(r.have, 20);
});

check('a value the agent could not determine stays unknown', () => {
  // `ss` not installed must not read as "the port is free" — that is the
  // difference between proposing an install and breaking a service.
  const r = readiness({ purpose: 'gateway', report: {
    'ports-free': null, 'nginx-installed': true, 'tls-cert': true, resolver: true,
  } });
  assert.equal(r.code, 'partly-unknown');
  assert.deepEqual(r.unknown, ['ports-free']);
  assert.equal(r.ready, false, 'unknown is not ready');
});

check('missing and unknown are reported apart', () => {
  const r = readiness({ purpose: 'gateway', report: {
    'ports-free': true, 'nginx-installed': false, 'tls-cert': null, resolver: false,
  } });
  assert.deepEqual(r.missing.sort(), ['nginx-installed', 'resolver']);
  assert.deepEqual(r.unknown, ['tls-cert']);
});

check('everything present is ready', () => {
  const r = readiness({ purpose: 'gateway', report: {
    'ports-free': true, 'nginx-installed': true, 'tls-cert': true, resolver: true,
  } });
  assert.equal(r.ready, true);
  assert.equal(r.code, 'ready');
});

console.log('\nCHANGING WHAT A MACHINE IS FOR:');

check('turning a running media server into a gateway is blocked', () => {
  // Something is serving video on it. That is not a field edit.
  const w = purposeChangeWarnings('nimble', 'gateway', { nimbleRunning: true });
  assert.equal(w.find(x => x.code === 'nimble-still-running')?.severity, 'block');
});

check('the same change on a stopped server is allowed', () => {
  assert.deepEqual(purposeChangeWarnings('nimble', 'gateway', { nimbleRunning: false }), []);
});

check('leaving a network warns rather than refuses', () => {
  // The routes stay where they are; the panel simply stops managing them.
  assert.equal(purposeChangeWarnings('nimble-cdn', 'nimble')[0]?.severity, 'warn');
});

check('no change produces no warnings', () => {
  assert.deepEqual(purposeChangeWarnings('gateway', 'gateway'), []);
});

console.log('\nTHE AGENT ONLY LOOKS:');

const agent = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
const handler = agent.slice(agent.indexOf("'GET /host/readiness'"), agent.indexOf("'GET /host/readiness'") + 2600);

check('the readiness endpoint installs nothing and writes nothing', () => {
  // The whole safety of this milestone: the cost of being wrong is a wrong
  // answer, not a broken machine.
  for (const forbidden of ['apt-get', 'apt ', 'yum', 'writeFile', 'systemctl start', 'systemctl restart', 'certbot']) {
    assert.ok(!handler.includes(forbidden), `the readiness handler runs "${forbidden}"`);
  }
});

check('the agent is new enough to be asked', () => {
  const m = /const AGENT_VERSION = (\d+)/.exec(agent);
  assert.ok(Number(m[1]) >= PREPARE_MIN_AGENT, `agent is v${m[1]}, the panel asks for v${PREPARE_MIN_AGENT}`);
});

check('the agent runs nothing through a shell', () => {
  // The oldest rule in the agent, and the first version of this milestone
  // broke it: a `sh -c` helper, with unit names and paths that arrive from a
  // panel over the network. Caught by the gate in the playlist suite; asserted
  // here too, beside the code that tempted it.
  assert.ok(/promisify\(execFile\)/.test(agent), 'the agent shells out');
  assert.ok(!/promisify\(exec\)\(/.test(agent), 'a shell helper is back');
});

check('a missing tool yields null rather than a confident false', () => {
  assert.ok(/return null;/.test(agent.slice(agent.indexOf('async function portListening'), agent.indexOf('async function certState'))),
    'portListening reports "free" when it could not look');
});

console.log(failures ? `\n${failures} readiness check(s) failed` : '\nall readiness checks passed');
process.exit(failures ? 1 : 0);
