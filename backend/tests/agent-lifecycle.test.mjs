// iter14 — keeping agents current, and noticing when one stops.
//
// The debounce is the part worth testing hardest. Without it an agent that
// misses one poll during a panel restart raises an alarm, and a flapping agent
// raises hundreds — and a notification channel that cries wolf is worse than
// none, because it trains the operator to ignore it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentRelease, versionState } from '../src/services/agentRelease.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};
const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

console.log('WHAT THE PANEL SHIPS:');

await acheck('the version and digest come from the file the panel serves', async () => {
  const rel = await agentRelease();
  assert.ok(rel.version > 0);
  assert.match(rel.sha256, /^[0-9a-f]{64}$/);
  // Deriving either from anywhere else would let them drift from what an
  // agent actually receives, and the whole mechanism rests on them matching.
  const body = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url));
  assert.equal(rel.bytes, body.length);
  assert.ok(body.toString('utf8').includes(`const AGENT_VERSION = ${rel.version};`));
});

await acheck('the shipped agent is byte-identical to the one in agent/', async () => {
  const vendored = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
  const original = readFileSync(new URL('../../agent/nnm-agent.mjs', import.meta.url), 'utf8');
  assert.equal(vendored, original, 'run: cp agent/nnm-agent.mjs backend/src/assets/nnm-agent.mjs');
});

console.log('\nVERSION COMPARISON:');

check('exact match is current', () => assert.equal(versionState(7, 7), 'current'));
check('behind is outdated', () => assert.equal(versionState(5, 7), 'outdated'));

check('ahead is its own state, not "current"', () => {
  // The panel was rolled back while its agents were not. Reporting that as
  // current would be telling the operator something untrue.
  assert.equal(versionState(9, 7), 'ahead');
});

check('an agent that has not reported is unknown, not outdated', () => {
  assert.equal(versionState(0, 7), 'unknown');
  assert.equal(versionState(undefined, 7), 'unknown');
  assert.equal(versionState(null, 7), 'unknown');
});

console.log('\nWATCHDOG DEBOUNCE (the transition logic, in isolation):');

// The rule as implemented: a verdict must repeat CONFIRM times before it is
// announced, any change of verdict restarts the count, and a verdict is
// announced once until it changes.
function watcher(confirm = 3) {
  let code = null, streak = 0, announced = null;
  const events = [];
  return {
    events,
    feed(next) {
      streak = code === next ? streak + 1 : 1;
      code = next;
      if (streak >= confirm && announced !== next) {
        const healthy = next === 'healthy';
        if (!healthy || (announced && announced !== 'healthy')) events.push({ code: next, healthy });
        announced = next;
      }
    },
  };
}

check('one missed reading says nothing', () => {
  const w = watcher();
  w.feed('healthy'); w.feed('healthy'); w.feed('healthy');
  w.feed('stopped-polling');
  assert.deepEqual(w.events, [], 'a panel restart must not raise an alarm');
});

check('a fault that persists is announced exactly once', () => {
  const w = watcher();
  for (let i = 0; i < 10; i++) w.feed('stopped-polling');
  assert.equal(w.events.length, 1);
  assert.equal(w.events[0].code, 'stopped-polling');
});

check('an agent down for an hour produces one event, not a hundred and twenty', () => {
  const w = watcher();
  for (let i = 0; i < 120; i++) w.feed('no-contact');
  assert.equal(w.events.length, 1);
});

check('flapping produces nothing at all', () => {
  const w = watcher();
  for (let i = 0; i < 30; i++) w.feed(i % 2 ? 'healthy' : 'stopped-polling');
  assert.deepEqual(w.events, [], 'alternating verdicts never reach the confirm count');
});

check('recovery is announced, but only if a fault was', () => {
  const w = watcher();
  for (let i = 0; i < 4; i++) w.feed('stopped-polling');
  for (let i = 0; i < 4; i++) w.feed('healthy');
  assert.equal(w.events.length, 2);
  assert.equal(w.events[1].healthy, true);
});

check('a healthy agent from the start is never announced', () => {
  const w = watcher();
  for (let i = 0; i < 20; i++) w.feed('healthy');
  assert.deepEqual(w.events, [], 'nothing happened, so nothing is said');
});

check('one fault replacing another is announced as the new one', () => {
  const w = watcher();
  for (let i = 0; i < 4; i++) w.feed('stopped-polling');
  for (let i = 0; i < 4; i++) w.feed('restart-loop');
  assert.deepEqual(w.events.map(e => e.code), ['stopped-polling', 'restart-loop']);
});

console.log('\nSAFETY OF THE MECHANISM:');

const watchdogSrc = readFileSync(new URL('../src/services/agentWatchdog.js', import.meta.url), 'utf8');
const fleetSrc = readFileSync(new URL('../src/routes/agentFleet.js', import.meta.url), 'utf8');
const agentSrc = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');

check('the watchdog never acts, only records', () => {
  // An automatic action on a false positive is more dangerous than the fault:
  // it would be the panel reaching into a live broadcast server because a
  // heartbeat was late.
  assert.ok(!/runTask|enqueueTask|runOverSsh|systemctl/.test(watchdogSrc),
    'detection and action must stay separate');
});

check('the panel asks for an update, it does not upload one', () => {
  // The task carries a digest and a version. The bytes come from a route the
  // agent calls itself, and are rejected if they do not match.
  assert.ok(fleetSrc.includes("enqueueTask(server, 'POST /self-update'"));
  assert.ok(fleetSrc.includes('sha256: rel.sha256'));
  assert.ok(!fleetSrc.includes('rel.body'), 'the code itself must not travel in the task');
});

check('the agent verifies before it replaces itself', () => {
  const from = agentSrc.indexOf("'POST /self-update'");
  const to = agentSrc.indexOf("'POST /media/fetch'", from);
  const handler = agentSrc.slice(from, to);
  assert.ok(handler.indexOf('checksum mismatch') < handler.indexOf('fs.rename'),
    'the rename must come after the check');
  assert.ok(handler.includes('.bak'), 'the working code is kept');
  assert.ok(handler.includes('process.exit(9)'), 'a non-zero exit is what makes systemd start the new code');
});

check('an agent that cannot rewrite itself says so instead of trying', () => {
  assert.ok(agentSrc.includes('canSelfUpdate'));
  assert.ok(agentSrc.includes('reinstall it from the panel'));
});

check('bulk update skips agents that are not polling', () => {
  // Queueing for an absent agent produces a task that expires and an operator
  // who believes something happened.
  assert.ok(fleetSrc.includes("reason: 'not-polling'"));
  assert.ok(fleetSrc.includes("reason: 'read-only-install'"));
});

check('recovery is a request, never a schedule', () => {
  assert.ok(fleetSrc.includes("requirePerm('servers.manage')"));
  assert.ok(!/setInterval/.test(fleetSrc), 'nothing in recovery may run on a timer');
});

check('the recovery commands are a fixed list, not a shell', () => {
  assert.ok(fleetSrc.includes('const RECOVER = ['));
  assert.ok(fleetSrc.includes("cmd: 'systemctl restart nnm-agent'"));
  assert.ok(fleetSrc.includes('grep -v TOKEN'), 'the env file is read without its secret');
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall agent-lifecycle checks passed');
process.exit(fail ? 1 : 0);
