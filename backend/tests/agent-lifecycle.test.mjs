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

console.log('\nA BUSY AGENT IS NOT AN UNCLAIMED ONE (v0.27.2):');

check('a task queued moments ago is not "not claimed"', () => {
  // The rule was written for a system where tasks were rare. Since iter16 the
  // panel asks the agent for every native read, so tasks arrive continuously —
  // and at any instant there is one queued a moment ago and a contact a moment
  // before that. It fired constantly on a healthy agent, which is worse than
  // not having the signal: it makes the one that matters unreadable.
  const POLL_CYCLE_MS = 25_000;
  const fires = (queuedAgo, contactAgo) => {
    const now = Date.now();
    return (now - contactAgo) > (now - queuedAgo) + POLL_CYCLE_MS;
  };
  assert.equal(fires(200, 100), false, 'a busy agent');
  assert.equal(fires(5_000, 1_000), false, 'still within a poll cycle');
  assert.equal(fires(30_000, 1_000), true, 'genuinely passed over');
});

check('the rule is in the diagnosis, not only here', () => {
  const src = readFileSync(new URL('../src/services/agentDiagnosis.js', import.meta.url), 'utf8');
  assert.ok(src.includes('const POLL_CYCLE_MS = 25_000'));
  assert.ok(src.includes('ms(x.createdAt) + POLL_CYCLE_MS'));
});

check('the diagnostic routes on freshness, as the panel does', () => {
  // Reading the diagnosis code instead reported "a direct call" for an agent
  // serving every read perfectly well. Routing and health are different
  // questions.
  const diag = readFileSync(new URL('../../tools/nnm-diag.mjs', import.meta.url), 'utf8');
  assert.ok(diag.includes('const agentFresh ='));
  assert.ok(diag.includes('< 90_000'), 'the same 90s the client uses');
  assert.ok(!diag.includes("mine.code === 'healthy' ?"), 'the proxy for it is gone');
  assert.ok(diag.includes('reads still go through it'), 'and a poor diagnosis is still reported');
});

console.log('\nTHE INSTALLER BRINGS ITS OWN NODE (v0.29.0):');

const { installScript } = await import('../src/services/agentInstaller.js');
const sh = installScript({ panelUrl: 'https://panel', ticket: 'a'.repeat(64) });

check('it no longer refuses when Node is absent', () => {
  // Refusing puts the work back on the operator for something the installer
  // can do itself — and the SSH install, which exists so nobody has to touch
  // the server, failed for exactly that.
  assert.ok(!sh.includes('node is required (Node 18+); install it and re-run'));
  assert.ok(sh.includes('NODE_VERSION='));
});

check('it installs into the agent\'s own directory, not the system', () => {
  // A live broadcast server's toolchain is not this agent's to change, and a
  // system-wide Node can collide with whatever is already there.
  assert.ok(sh.includes('"$STATE_DIR/node"'));
  assert.ok(!/apt-get install|yum install|nodesource/i.test(sh), 'no package manager is invoked');
  assert.ok(sh.includes('nothing outside it was changed'));
});

check('a system Node that is new enough is used as it is', () => {
  // Downloading one anyway would be changing a machine that needed nothing.
  const order = [sh.indexOf('if node_ok node;'), sh.indexOf('$STATE_DIR/node/bin/node'), sh.indexOf('fetching')];
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], 'system, then a previous install, then fetch');
});

check('the download is verified against the release manifest', () => {
  // An interrupted or substituted download must fail loudly rather than
  // install.
  assert.ok(sh.includes('SHASUMS256.txt'));
  assert.ok(sh.includes('sha256sum'));
  assert.ok(sh.includes('node checksum mismatch — refusing to install'));
});

check('the checksum lookup cannot match the wrong file', () => {
  // The manifest lists several formats per architecture.
  const manifest = ['aa  node-v22.20.0-linux-x64.tar.xz', 'cc  node-v22.20.0-linux-x64.tar.gz'];
  const pick = (t) => (manifest.find(l => l.endsWith(` ${t}`)) || '').split(/\s+/)[0];
  assert.equal(pick('node-v22.20.0-linux-x64.tar.xz'), 'aa');
  assert.equal(pick('node-v22.20.0-linux-s390x.tar.xz'), '', 'and an arch with no build is not silently mismatched');
  assert.ok(sh.includes("awk -v f=\"$TARBALL\""), 'an exact field match, not a regex');
  assert.ok(!sh.includes('grep " $TARBALL'), 'the subtle anchored grep is gone');
});

check('an architecture with no official build says so', () => {
  assert.ok(sh.includes('no official build for'));
  assert.ok(sh.includes('x86_64|amd64') && sh.includes('aarch64|arm64'));
});

check('the unit runs the Node that was settled on', () => {
  // `command -v node` in the unit would find a different one, or none, once
  // systemd's PATH differs from the installing shell's.
  assert.ok(sh.includes('ExecStart=$NODE_BIN $BIN'));
  assert.ok(!sh.includes('ExecStart=$(command -v node)'));
});

console.log('\nA MIXED-VERSION FLEET (v0.38.0):');

const clientSrc2 = readFileSync(new URL('../src/services/nimbleClient.js', import.meta.url), 'utf8');
const agentFile = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');

check('an agent too old for a route falls back instead of failing', () => {
  // This listed the failures worth falling back from and missed the one that
  // matters: an agent older than v10 has no `POST /nimble` and answers "no
  // handler for ...". A fleet of older agents would have lost native
  // statistics entirely rather than falling back to a direct call.
  const rethrows = (msg) => /^Nimble API HTTP/.test(msg) || /^nimble returned \d+ for /.test(msg);
  assert.equal(rethrows('no handler for POST /nimble'), false);
  assert.equal(rethrows('task timed out'), false);
  assert.equal(rethrows('agent is not enabled for this server'), false);
  // Answers that came from Nimble itself are the answer: asking again would
  // only reproduce them.
  assert.equal(rethrows('Nimble API HTTP 404'), true);
  assert.equal(rethrows('nimble returned 500 for /manage/x'), true);
  assert.ok(clientSrc2.includes('const fromNimble ='));
});

check('an unknown route fails fast, not on a timeout', () => {
  // Twenty seconds per call on an old agent would make the panel look broken
  // rather than the agent look old.
  assert.ok(agentFile.includes('throw new Error(`no handler for ${task.route}`)'));
  assert.ok(agentFile.includes("panelFetch(`/task/${task.id}/result`, { ok: false"));
});

check('the media root is fixed, not derived from the upload directory', () => {
  // dirname(MEDIA_DIR) was convenient and wrong: with MEDIA_DIR at
  // /srv/nimble/media it yields /srv/nimble, which contains conf/ and so the
  // agent's own token. A default that widens as a configuration gets simpler
  // is the wrong shape for a permission.
  assert.ok(!agentFile.includes('path.dirname(MEDIA_DIR)'));
  assert.ok(agentFile.includes("const dflt = '/srv/nimble/media'"));
  const pick = (raw) => {
    if (!raw) return '/srv/nimble/media';
    return raw.split('/').filter(Boolean).length < 2 ? '/srv/nimble/media' : raw;
  };
  assert.equal(pick(undefined), '/srv/nimble/media');
  assert.equal(pick('/srv'), '/srv/nimble/media', 'too broad, narrowed');
  assert.equal(pick('/'), '/srv/nimble/media');
  assert.equal(pick('/opt/nimble/media'), '/opt/nimble/media', 'a real directory is honoured');
});

check('a bad setting never stops the agent from starting', () => {
  // Throwing was the first attempt and was worse than the problem: an agent
  // that will not start cannot self-update to a fix either, on a machine that
  // by design has no inbound route. Someone would have to be sent to it.
  const block = agentFile.slice(agentFile.indexOf('const MEDIA_ROOT'), agentFile.indexOf('const MEDIA_ROOT') + 900);
  assert.ok(!/throw new Error/.test(block));
  assert.ok(block.includes('console.error'), 'refused loudly and carried on');
});

check('nothing new can abort start-up', () => {
  // Every throw added by iter19 is inside a handler. The only top-level exit
  // is the token check, which predates this and is correct.
  const head = agentFile.slice(0, agentFile.indexOf('const routes ='));
  const topLevelThrows = head.split('\n')
    .filter(l => /^\s*throw /.test(l) && !/^\s*\/\//.test(l));
  assert.deepEqual(topLevelThrows, []);
});

check('a v9 agent will accept the new file as an update', () => {
  // The check the OLD agent applies to a replacement before becoming it. If
  // the new file failed it, the fleet would be stuck at v9 with no way
  // forward but a visit.
  assert.ok(agentFile.startsWith('#!'));
  assert.ok(agentFile.includes('AGENT_VERSION'));
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall agent-lifecycle checks passed');
process.exit(fail ? 1 : 0);
