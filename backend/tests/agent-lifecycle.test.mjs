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

console.log('\nTHE SANITY CHECK MUST PASS THE REAL AGENT:');

await acheck('the shipped agent satisfies its own download check', async () => {
  // The first version looked for 'nnm-agent' in the leading 200 bytes, where
  // the file has a shebang and a title in capitals. It never matched, so
  // self-update failed on every agent — with a message that sounded like the
  // download had been tampered with.
  const rel = await agentRelease();
  const text = rel.body.toString('utf8');
  assert.ok(text.startsWith('#!'), 'the agent is executable and starts with a shebang');
  assert.ok(text.includes('AGENT_VERSION'), 'and carries its version marker');
});

check('the check is written against the whole file, not a prefix', () => {
  const from = agentSrc.indexOf("'POST /self-update'");
  const handler = agentSrc.slice(from, agentSrc.indexOf("'POST /media/fetch'", from));
  assert.ok(!handler.includes('subarray(0, 200)'), 'a prefix window is how the marker was missed');
  assert.ok(handler.includes("text.startsWith('#!')"));
});

check('an HTML error page returned with a 200 is still rejected', () => {
  const looksLikeAgent = (t) => t.startsWith('#!') && t.includes('AGENT_VERSION');
  assert.equal(looksLikeAgent('<!doctype html><title>502 Bad Gateway</title>'), false);
  assert.equal(looksLikeAgent('#!/usr/bin/env node\nconst AGENT_VERSION = 9;'), true);
});

console.log('\nPREFERENCES ARE ACTUALLY STORED:');

check('the dashboard block is declared on the user schema', () => {
  // `preferences` is a TYPED sub-schema, so mongoose discards any key it does
  // not declare — silently. The write appeared to succeed, vanished on save,
  // and the dashboard reverted to its defaults on every reload.
  const userSrc = readFileSync(new URL('../src/models/User.js', import.meta.url), 'utf8');
  assert.ok(userSrc.includes('dashboard: { type: mongoose.Schema.Types.Mixed'));
});

console.log('\nA BROKEN UPDATER CANNOT FIX ITSELF:');

const fleetSrc3 = readFileSync(new URL('../src/routes/agentFleet.js', import.meta.url), 'utf8');
const centreSrc2 = readFileSync(new URL('../../frontend/src/components/AgentCentreModal.jsx', import.meta.url), 'utf8');

check('the panel recognises the deadlock', () => {
  // Agents up to v8 shipped a download check that could never pass. The fix is
  // in the new agent — which that agent refuses to accept. Retrying cannot
  // work: the code doing the checking IS the code being replaced.
  assert.ok(fleetSrc3.includes('updateStuck:'));
  assert.ok(fleetSrc3.includes('/does not look like the agent/i'));
});

check('the button that cannot succeed is not offered', () => {
  assert.ok(centreSrc2.includes('!s.updateStuck && ('), 'no retry for a retry that cannot work');
  assert.ok(centreSrc2.includes("t('ac.updateStuck')"), 'the way out is named instead');
});

check('the deadlock flag clears once it is no longer true', () => {
  // Derived from task history alone, it kept firing after a reinstall had
  // fixed it — the panel telling an operator to fix what they had just fixed.
  const versionState = (r, sh) => { const n = Number(r); return !n ? 'unknown' : n === sh ? 'current' : n < sh ? 'outdated' : 'ahead'; };
  const stuck = (agentVer, shipped, tasks) => {
    if (versionState(agentVer, shipped) !== 'outdated') return false;
    const t = tasks.find(x => x.status === 'failed' && Number(x.body?.version || 0) > Number(agentVer || 0));
    return Boolean(t) && /does not look like the agent/i.test(t?.error || '');
  };
  const history = [{ status: 'failed', body: { version: 9 }, error: 'the downloaded file does not look like the agent' }];
  assert.equal(stuck(8, 9, history), true, 'while it is true');
  assert.equal(stuck(9, 9, history), false, 'and not after the reinstall');
  assert.equal(stuck(9, 10, history), false, 'nor for a failure aimed at a version already running');
});

check('the panel-side rule matches that', () => {
  assert.ok(fleetSrc3.includes("if (versionState(a.version, rel.version) !== 'outdated') return false"));
  assert.ok(fleetSrc3.includes('Number(x.body?.version || 0) > Number(a.version || 0)'));
});

check('reinstalling really is the way out', () => {
  // Worth asserting rather than assuming: it must replace the binary and keep
  // the token, or the advice costs the operator their enrollment.
  const inst = readFileSync(new URL('../src/services/agentInstaller.js', import.meta.url), 'utf8');
  assert.ok(inst.includes('mv "$BIN.new" "$BIN"'), 'the binary is replaced');
  assert.ok(inst.includes('keeping the current token'), 'and the token survives');
  assert.ok(inst.includes('STATE_DIR=/var/lib/nnm-agent'), 'landing where it can update itself next time');
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall agent-lifecycle checks passed');
process.exit(fail ? 1 : 0);
