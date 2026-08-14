// The helper that may change a machine, iter23 m4.
//
// The agent proper cannot install packages or write /etc, and that is not an
// oversight to route around: on fifteen media servers it needs two directories,
// and one that could install packages would be root across the fleet the moment
// the panel is compromised — and the panel is reachable over plain HTTP.
//
// So the privilege lives in a second unit, and every check here is about the
// limits rather than the capability. The capability is easy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privilegedInstaller, privilegedEligibility, stepAllowed, ALLOWED_PATHS, ALLOWED_BINARIES }
  from '../src/services/privilegedHelper.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const script = privilegedInstaller({ panelUrl: 'http://panel:8095', token: 'tok' });
const agent = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');

console.log('\nWHAT THE UNIT REQUIRES OF A CLEAN MACHINE:');

check('every writable path is created before the unit is enabled', () => {
  // systemd builds the mount namespace before the process runs, so a path that
  // is not there yet fails the unit outright with 226/NAMESPACE. Five of the
  // ten only appear once nginx and certbot are installed — by this very
  // helper, which cannot start to install them.
  //
  // ExecStartPre cannot fix it: that also runs inside the namespace, after it
  // has already failed to be built. It has to be the installer, while the
  // filesystem is still ordinary.
  const mkdirAt = script.indexOf('mkdir -p');
  const unitAt = script.indexOf('[Service]');
  assert.ok(mkdirAt > 0, 'nothing creates the writable directories');
  assert.ok(mkdirAt < unitAt, 'the directories are created after the unit is written');
  for (const p of ALLOWED_PATHS) {
    assert.ok(script.includes(p), `${p} is never created`);
  }
});

check('and every path is also marked optional, as a second line', () => {
  // A "-" makes systemd ignore a missing path. It fixes the crash and nothing
  // else — the namespace is fixed at start, so a directory created later is
  // still not writable. Belt for a path this list gains and the script
  // forgets; not the mechanism.
  for (const p of ALLOWED_PATHS) {
    assert.ok(new RegExp(`ReadWritePaths=[^\\n]*-${p.replace(/\//g, '\\/')}`).test(script),
      `${p} is not optional in ReadWritePaths`);
  }
});

check('a unit that cannot start stops instead of spinning', () => {
  // It restarted 740 times at two-second intervals while the real fault went
  // unnoticed. A unit that cannot start should be visibly stopped, not quietly
  // filling a journal.
  assert.match(script, /RestartSec=(\d+)/);
  assert.ok(Number(/RestartSec=(\d+)/.exec(script)[1]) >= 10, 'it restarts too fast to notice');
  assert.match(script, /StartLimitBurst=\d+/);
});

check('the state directory is granted by systemd, not by the path list', () => {
  // StateDirectory= is read-write even under ProtectSystem=strict, and systemd
  // creates it. Listing it in ReadWritePaths instead would put it back in the
  // must-exist-first trap.
  assert.match(script, /StateDirectory=nnm-agent-privileged/);
  assert.ok(!/ReadWritePaths=[^\n]*\/var\/lib\/nnm-agent/.test(script));
});

console.log('\nROOT, BUT NOT FREE:');

check('the unit lists what it may write, and it is a short list', () => {
  // The whole reason for a separate unit rather than a flag on the existing
  // one. Root that may write ten directories is a different thing from root.
  assert.match(script, /ReadWritePaths=/);
  assert.match(script, /ProtectSystem=strict/);
  for (const p of ALLOWED_PATHS) assert.ok(script.includes(p), `${p} is not in the unit`);
  assert.ok(ALLOWED_PATHS.length <= 12, 'the list has grown past the job it was written for');
});

check('nothing outside the gateway job is writable', () => {
  // Full control of the panel then buys nginx and certbot, not the machine.
  for (const forbidden of ['/etc/passwd', '/root', '/home', '/etc/shadow', '/etc/ssh', '/srv/nimble']) {
    assert.ok(!ALLOWED_PATHS.includes(forbidden), `${forbidden} is writable`);
    assert.ok(!stepAllowed({ kind: 'file', path: `${forbidden}/x` }), `${forbidden} passes the step check`);
  }
});

check('a path that merely starts with an allowed name is not allowed', () => {
  // `/etc/nginx-evil` is not `/etc/nginx`. A prefix match without the
  // separator is the classic way this kind of list is escaped.
  assert.ok(stepAllowed({ kind: 'file', path: '/etc/nginx/sites-available/x.conf' }));
  assert.ok(!stepAllowed({ kind: 'file', path: '/etc/nginx-evil/x' }));
});

check('only the binaries the job needs may run', () => {
  assert.ok(stepAllowed({ kind: 'package', command: ['apt-get', 'install', 'nginx'] }));
  assert.ok(!stepAllowed({ kind: 'command', command: ['bash', '-c', 'anything'] }));
  assert.ok(!stepAllowed({ kind: 'command', command: ['curl', 'http://x'] }));
  assert.ok(!stepAllowed({ kind: 'command', command: ['useradd', 'x'] }));
});

check('a full path to a forbidden binary is still forbidden', () => {
  // Comparing the whole string would let `/bin/sh` through while `sh` is
  // refused.
  assert.ok(!stepAllowed({ kind: 'command', command: ['/bin/sh', '-c', 'x'] }));
  assert.ok(stepAllowed({ kind: 'command', command: ['/usr/bin/systemctl', 'reload', 'nginx'] }));
});

check('an unknown step kind is refused rather than attempted', () => {
  assert.ok(!stepAllowed({ kind: 'script', body: 'x' }));
  assert.ok(!stepAllowed({}));
});

console.log('\nTHE LIMIT LIVES ON THE MACHINE TOO:');

check('the agent carries the same lists, and they match', () => {
  // Checked in the panel *and* in the helper. The plan is composed by the
  // panel, and the panel is the thing that might be compromised: a lock that
  // depends on its caller being honest is not a lock.
  for (const p of ALLOWED_PATHS) assert.ok(agent.includes(`'${p}'`), `the agent does not allow ${p}`);
  for (const b of ALLOWED_BINARIES) assert.ok(agent.includes(`'${b}'`), `the agent does not allow ${b}`);
  // And nothing extra on the agent's side, which would be a hole the panel
  // cannot see.
  const m = /const ALLOWED_BINARIES = \[([^\]]*)\]/.exec(agent);
  const onAgent = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  assert.deepEqual(onAgent.sort(), [...ALLOWED_BINARIES].sort());
});

check('an ordinary agent refuses the work instead of failing halfway', () => {
  // It used to attempt it and fail as a wall of apt complaining about
  // read-only filesystems, which reads as a broken machine.
  // Inside the apply handler, not merely somewhere in the file: the rollback
  // handler has the same guard, so matching the whole file passed with the
  // apply guard deleted — a check satisfied by a different guard than the one
  // it is about.
  const applyBody = agent.slice(agent.indexOf("'POST /host/apply'"), agent.indexOf("'POST /host/rollback'"));
  assert.ok(/if \(!PRIVILEGED\)/.test(applyBody), 'the apply handler has no privilege guard');
  assert.ok(/needsPrivileged: true/.test(applyBody));
  const rollbackBody = agent.slice(agent.indexOf("'POST /host/rollback'"), agent.indexOf("'POST /host/rollback'") + 600);
  assert.ok(/if \(!PRIVILEGED\)/.test(rollbackBody), 'the rollback handler has no privilege guard');
});

check('an agent cannot promote itself', () => {
  // The flag comes from the unit's environment file and from nothing else.
  assert.ok(/const PRIVILEGED = process\.env\.NNM_PRIVILEGED === '1'/.test(agent));
  assert.ok(!/PRIVILEGED = true/.test(agent), 'something sets the flag in code');
});

console.log('\nIT IS INSTALLED ON PURPOSE, AND ONLY WHERE IT IS NEEDED:');

check('a media server is refused it', () => {
  // Its whole justification is that a gateway needs system changes and a media
  // server does not. An installer offered everywhere ends up everywhere.
  assert.equal(privilegedEligibility({ purpose: 'nimble', agent: { enabled: true } }).code, 'not-a-gateway');
  assert.equal(privilegedEligibility({ purpose: 'nimble-cdn', agent: { enabled: true } }).ok, false);
  assert.equal(privilegedEligibility({ purpose: 'gateway', agent: { enabled: true } }).ok, true);
});

check('a machine without the ordinary agent is refused', () => {
  // The helper reuses its binary and its enrolment; there is nothing to add
  // privilege to.
  assert.equal(privilegedEligibility({ purpose: 'gateway', agent: { enabled: false } }).code, 'no-agent');
});

check('it listens on loopback only', () => {
  // Nothing outside the machine reaches it, whatever happens to the panel.
  // The variable is the agent's own name for it — the helper's environment is
  // the agent's, and a name the agent does not read is a setting that does
  // nothing.
  assert.ok(!/NNM_AGENT_BIND=/.test(script) || /NNM_AGENT_BIND='127\.0\.0\.1'/.test(script));
  assert.ok(/bind = '127\.0\.0\.1'/.test(
    readFileSync(new URL('../src/services/privilegedHelper.js', import.meta.url), 'utf8')));
});

check('it is its own unit, with its own life', () => {
  // Disabling it takes one command and leaves an ordinary machine behind, and
  // removing one unit must not disturb the other.
  assert.match(script, /nnm-agent-privileged\.service/);
  assert.ok(!/Wants=nnm-agent/.test(script), 'the two units are tied together');
  assert.match(script, /systemctl disable --now nnm-agent-privileged/);
});

check('the script says what it is before it does it', () => {
  // It is read by an operator before it is run, and a script somebody can read
  // is a script somebody can refuse.
  assert.match(script, /runs as root/);
  assert.match(script, /To remove it entirely/);
});

check('it refuses to run as anything but root, and without the agent', () => {
  assert.match(script, /id -u.*!= *"0"|\[ "\$\(id -u\)" = "0" \]/);
  assert.match(script, /the agent binary was not found/);
});

check('the helper has somewhere to write its own state', () => {
  // The agent writes a log cursor into STATE_DIRECTORY at startup. Without the
  // line the helper inherited nothing, fell back to /var/lib/nnm-agent, and
  // found it read-only under ProtectSystem=strict — so it enabled, started,
  // threw and stopped. From the installer that was "it did not start".
  assert.match(script, /StateDirectory=nnm-agent-privileged/);
  // Its own, not the agent's: two processes sharing one cursor would each
  // rewind the other.
  assert.ok(!/StateDirectory=nnm-agent$/m.test(script));
});

check('every writable thing it needs is either listed or granted', () => {
  // ProtectSystem=strict means anything not named is read-only, and a process
  // that cannot write where it expects to exits without explaining itself.
  const rw = /ReadWritePaths=([^\n]*)/.exec(script)[1];
  const state = /StateDirectory=(\S+)/.exec(script)[1];
  assert.ok(rw.includes('/etc/nginx') && rw.includes('/var/lib/dpkg'));
  assert.ok(state, 'nothing grants a state directory');
});

check('a helper that will not start prints why, not where to look', () => {
  // Somebody reading an install log is often not on the machine, and "run
  // journalctl" is not something they can act on. It cost a release: the log
  // said "it did not start" and the reason was one command away on a box
  // nobody was sitting at.
  assert.ok(/journalctl -u nnm-agent-privileged -n \d+ --no-pager/.test(script));
  assert.ok(/systemctl status nnm-agent-privileged/.test(script));
});

check('the helper looks for node where the agent puts it', () => {
  // The agent installs a private node into its state directory when the system
  // has none, and never touches PATH. The helper looked only at PATH, found
  // nothing, and stopped with "node is required" on a machine with a working
  // node ten centimetres away — one the agent was running on at that moment.
  const inst = readFileSync(new URL('../src/services/agentInstaller.js', import.meta.url), 'utf8');
  const stateDir = /STATE_DIR=(\S+)/.exec(inst)?.[1];
  const nodePath = /NODE_BIN="\$STATE_DIR\/(\S+?)"/.exec(inst)?.[1];
  assert.ok(stateDir && nodePath, 'the installer no longer says where it puts node');
  assert.ok(script.includes(`${stateDir}/${nodePath}`),
    `the helper does not look in ${stateDir}/${nodePath}`);
});

check('and falls back to the node the agent is running on', () => {
  // The most reliable answer available: whatever is executing the agent right
  // now is, by definition, a node that works.
  assert.ok(/systemctl show -p ExecStart[\s\S]{0,120}node/.test(script));
  assert.ok(/using node:/.test(script), 'it does not say which node it took');
});

check('every path the helper depends on is one the installer creates', () => {
  // Two of these have now cost a release each: the agent binary and node, both
  // hard-coded to somewhere the installer does not write. Bound to the
  // installer rather than to a literal so the next one cannot.
  const inst = readFileSync(new URL('../src/services/agentInstaller.js', import.meta.url), 'utf8');
  const stateDir = /STATE_DIR=(\S+)/.exec(inst)[1];
  for (const needed of ['/nnm-agent.mjs', '/node/bin/node']) {
    assert.ok(script.includes(stateDir + needed),
      `the helper does not know about ${stateDir}${needed}`);
  }
});

console.log('\nTHE HELPER TRAVELS WITH THE INSTALL, ON GATEWAYS ONLY:');

const { installScript } = await import('../src/services/agentInstaller.js');
const gwScript = installScript({ panelUrl: 'http://p:8095', ticket: 'T', purpose: 'gateway', token: 'tok' });
const mediaScript = installScript({ panelUrl: 'http://p:8095', ticket: 'T', purpose: 'nimble' });

check('a gateway install carries the helper', () => {
  // The SSH install already runs as root, so the helper goes in with it rather
  // than being a second thing to remember on a machine whose whole purpose
  // needs it.
  assert.ok(gwScript.includes('nnm-agent-privileged'));
  assert.ok(gwScript.includes('ReadWritePaths='));
});

check('a media server install does not contain it at all', () => {
  // Absent rather than disabled. A block that exists and is skipped is a block
  // somebody can enable by accident; one that was never rendered is not.
  assert.ok(!mediaScript.includes('nnm-agent-privileged'));
  assert.ok(!mediaScript.includes('NNM_PRIVILEGED'));
});

check('and it says why it is absent, rather than saying nothing', () => {
  // A script that silently differs between machines is one nobody can compare.
  assert.ok(/no reason to be able to install packages/.test(mediaScript));
});

check('the ticket carries the purpose, because the script is fetched later', () => {
  // The install URL is unauthenticated by design — that is what a single-use
  // ticket is for — so at fetch time there is no server to look up. Deciding
  // the privilege level then would mean deciding it from whatever the fetcher
  // says.
  const enroll = readFileSync(new URL('../src/routes/agentEnroll.js', import.meta.url), 'utf8');
  const model = readFileSync(new URL('../src/models/AgentEnrollment.js', import.meta.url), 'utf8');
  assert.ok(/purpose: \{ type: String/.test(model), 'the ticket has no purpose');
  assert.ok(/purpose: server\?\.purpose \|\| 'nimble'/.test(enroll), 'the purpose is not stored on the ticket');
  assert.ok(/purpose: server\?\.purpose \|\| doc\.purpose/.test(enroll), 'the script does not read it back');
});

check('a failing helper does not fail the agent install', () => {
  // The agent is the thing that had to work. A helper that will not install
  // leaves a machine the panel can still see and talk to, which is a much
  // better place to debug from than one with nothing on it.
  assert.ok(/THE PRIVILEGED HELPER DID NOT INSTALL \(the agent itself is fine\)/.test(gwScript));
});

check('and the last line says so, because the last line is what gets read', () => {
  // A one-line "or echo" put the reason a hundred lines above a summary
  // reading "done", and the summary is what an operator reads. Twice, on two
  // rebuilt machines.
  assert.ok(/done, WITH ONE FAILURE/.test(gwScript));
  assert.ok(/agent and the privileged helper are installed/.test(gwScript));
});

check('the helper looks where the agent actually is', () => {
  // It looked in /usr/local/lib and the installer writes /var/lib/nnm-agent,
  // so it exited before doing anything — and the failure landed in the middle
  // of a successful-looking install. A default that is wrong is worse than
  // none: it looks like a decision somebody made.
  assert.match(script, /BIN='\/var\/lib\/nnm-agent\/nnm-agent\.mjs'/);
  assert.ok(script.includes('/usr/local/lib/nnm-agent.mjs'), 'the older location is not tried');
  assert.ok(/systemctl show -p ExecStart/.test(script), 'the running unit is not consulted');
  assert.ok(/using agent binary/.test(script), 'it does not say which one it took');
});

check('the path it looks for matches the path the installer writes', () => {
  // Bound to both files rather than to a literal: the two drifted apart once
  // and nothing noticed until a machine had been rebuilt twice.
  const inst = readFileSync(new URL('../src/services/agentInstaller.js', import.meta.url), 'utf8');
  const stateDir = /STATE_DIR=(\S+)/.exec(inst)?.[1];
  const binLine = /BIN=\$STATE_DIR\/(\S+)/.exec(inst)?.[1];
  assert.ok(stateDir && binLine, 'the installer no longer says where it puts the agent');
  assert.ok(script.includes(`${stateDir}/${binLine}`),
    `the helper looks elsewhere than ${stateDir}/${binLine}`);
});

console.log('\nTHE ORDER OF WORK IS NOT A TRAP:');

const enrollSrc = readFileSync(new URL('../src/routes/agentEnroll.js', import.meta.url), 'utf8');
const serversSrc = readFileSync(new URL('../src/routes/servers.js', import.meta.url), 'utf8');
const card = readFileSync(new URL('../../frontend/src/pages/ServerAgentsPage.jsx', import.meta.url), 'utf8');
const dlg = readFileSync(new URL('../../frontend/src/components/GatewaySetupModal.jsx', import.meta.url), 'utf8');

check('the script uses the purpose as it is when fetched, not when issued', () => {
  // Otherwise: issue a ticket, realise the machine is a gateway, change its
  // purpose — and the script fetched afterwards is still the media-server one,
  // silently, with no way to tell from outside. The ticket identifies the
  // server, so looking it up at fetch time is exactly as trustworthy as the
  // ticket.
  assert.ok(/const live = await NimbleServer\.findById\(doc\.serverId\)/.test(enrollSrc),
    'the fetch does not read the live server');
  assert.ok(/scriptFor\(doc, req\.params\.ticket, live\)/.test(enrollSrc));
});

check('the ticket keeps its own copy as a fallback', () => {
  // For a server since deleted, and as the record of what was intended.
  assert.ok(/server\?\.purpose \|\| doc\.purpose \|\| 'nimble'/.test(enrollSrc));
});

check('whether the helper is present comes from its own polling', () => {
  // Read from a single shared lastHealth, `privileged` flapped between true
  // and false as the two instances took turns writing it — the panel said "no
  // helper" and then stopped, with nothing having changed on the machine.
  assert.ok(/s\.helper\?\.seen/.test(serversSrc), 'the helper has no record of its own');
  assert.ok(/privileged: PRIVILEGED/.test(readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8')),
    'the agent does not report which unit it is');
  const gw = readFileSync(new URL('../src/routes/agentGateway.js', import.meta.url), 'utf8');
  assert.ok(/server\.helper\.seen = true/.test(gw), 'nothing records that a helper polled');
});

check('never asked is not the same as absent', () => {
  // `null` for a machine nothing has reported from: an unanswered question,
  // not a missing helper.
  const line = serversSrc.slice(serversSrc.indexOf('privileged: s.helper?.seen'),
                                serversSrc.indexOf('privileged: s.helper?.seen') + 160);
  assert.ok(/: null/.test(line), 'a machine nobody has heard from is reported as having no helper');
  // And the UI only complains about `false`, never about `null`.
  assert.ok(/s\.privileged === false/.test(card), 'the card treats unknown as missing');
  assert.ok(/server\.privileged === false/.test(dlg), 'the dialog treats unknown as missing');
});

check('a missing helper is said before the attempt, not after it refuses', () => {
  // Every apply would refuse, which reads as a broken panel until somebody
  // says otherwise.
  const before = dlg.indexOf('gw.helper.missing');
  const attempt = dlg.indexOf('gw.setup.preview');
  assert.ok(before > 0 && before < attempt, 'the warning comes after the buttons that would fail');
});

check('the helper inherits the agent\'s environment rather than composing one', () => {
  // Two attempts failed here. The first embedded the literal "$AGENT_TOKEN";
  // the second substituted a real token into variables the agent does not read
  // — NNM_TOKEN, PORT, BIND — so the helper started with no token on the wrong
  // port, polled, was ignored, and never appeared. Nothing failed loudly.
  //
  // And composing could not work regardless: the agent gains
  // NNM_AGENT_SERVER_ID only when it enrols, and without it there is no
  // polling at all.
  assert.ok(/\/etc\/nnm-agent\.env > "\$ENV_FILE"/.test(script), 'the helper composes its own environment');
  assert.ok(/NNM_PRIVILEGED=1/.test(script));
  assert.ok(/NNM_AGENT_PORT=/.test(script), 'the port is not overridden');
});

check('every variable it writes is one the agent reads', () => {
  // The check that would have caught both attempts: a name the agent never
  // looks at is a setting that silently does nothing.
  const agentSrc = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
  const written = [...script.matchAll(/^(NNM_[A-Z_]+)=/gm)].map(m => m[1]);
  assert.ok(written.length >= 2, `only ${written.length} variables written`);
  for (const name of written) {
    assert.ok(agentSrc.includes(`process.env.${name}`),
      `the helper sets ${name} and the agent never reads it`);
  }
});

check('no token means no helper, said rather than installed broken', () => {
  // Installing it against an unenrolled agent produces a service that runs,
  // polls, is refused, and looks installed — the worst of the three outcomes.
  assert.ok(/the agent has no token yet/.test(script));
});

console.log('\nA GATEWAY IS NOT ASKED MEDIA-SERVER QUESTIONS:');

const detail = readFileSync(new URL('../../frontend/src/pages/ServerDetailPage.jsx', import.meta.url), 'utf8');

check('the media-server tabs are not shown on a gateway', () => {
  // Every one of them asks a media server a question, and "not mapped to
  // WMSPanel" on a machine that will never be in WMSPanel reads as a fault
  // rather than as the category error it is.
  assert.ok(/\(server\?\.purpose \|\| 'nimble'\) === 'gateway' \?/.test(detail));
  assert.ok(/server\.gateway\.title/.test(detail));
});

check('it says where the real work is instead of showing nothing', () => {
  const d2 = readFileSync(new URL('../../frontend/src/i18n.jsx', import.meta.url), 'utf8');
  assert.equal((d2.match(/'server\.gateway\.where':/g) || []).length, 2);
});

console.log('\nTHE SCRIPT IS SHOWN WHERE IT IS ASKED FOR:');

const ui2 = readFileSync(new URL('../../frontend/src/components/GatewaySetupModal.jsx', import.meta.url), 'utf8');

check('the script renders outside the block that needs an apply first', () => {
  // It sat inside `{result && …}`, which only renders after an apply has been
  // attempted. So pressing the button fetched the script and displayed it
  // nowhere — the same screen as a button that does nothing, and the operator
  // pressed it twice and reported it broken.
  const fetchAt = ui2.indexOf('gw.helper.get');
  const showAt = ui2.indexOf('helper.script');
  const resultAt = ui2.indexOf('{result && (');
  assert.ok(showAt > 0, 'the script is not rendered at all');
  assert.ok(showAt < resultAt, 'the script only renders after an apply has been attempted');
  assert.ok(showAt > fetchAt, 'the script is rendered above the button that fetches it');
});

check('it can be copied, since it is meant to be run elsewhere', () => {
  // A script to paste into a root shell that can only be selected by hand in a
  // scrolling box is a script somebody will truncate.
  assert.ok(/copyText\(helper\.script\)/.test(ui2));
});

console.log('\nA GATEWAY INSTALL DOES NOT ASK ABOUT NIMBLE:');

const instUi = readFileSync(new URL('../../frontend/src/components/AgentInstallModal.jsx', import.meta.url), 'utf8');

check('the Nimble log directory is not asked for on a gateway', () => {
  // There is no Nimble on it, so there are no logs. A pre-filled path reads as
  // a fact about the machine.
  assert.ok(/const isGateway = \(server\?\.purpose \|\| 'nimble'\) === 'gateway'/.test(instUi));
  assert.ok(/isGateway \?[\s\S]{0,200}inst\.noNimbleLogs/.test(instUi), 'nothing replaces the field');
});

check('and an empty directory is sent rather than a plausible one', () => {
  // Sending /var/log/nimble would have the agent watch a directory that will
  // never exist, and report its absence forever.
  assert.ok(/logDir: isGateway \? '' :/.test(instUi));
});

console.log('\nREMOVING THE AGENT IS THE INSTALL IN REVERSE:');

const { uninstallScript } = await import('../src/services/agentUninstaller.js');
const un = uninstallScript();

check('it removes the agent, the helper, the units and the token', () => {
  for (const gone of ['nnm-agent.service', 'nnm-agent-privileged.service',
                      '/etc/nnm-agent.env', '/var/lib/nnm-agent/nnm-agent.mjs']) {
    assert.ok(un.includes(gone), `${gone} survives an uninstall`);
  }
});

check('it does not touch Nimble', () => {
  // The agent wrote into those directories; that does not make them its own,
  // and a script that took both would be doing something nobody asked for.
  assert.ok(!/rm -rf \/srv\/nimble|rm -f \/srv\/nimble/.test(un), 'it removes media-server content');
  assert.ok(/Nimble and its directories were not touched/.test(un), 'it does not say what it left alone');
});

check('the state directory survives unless asked for', () => {
  // It holds the log cursor. A reinstall that resumes is usually wanted;
  // re-reading a fortnight of logs is not.
  assert.ok(!/rm -rf \/var\/lib\/nnm-agent\b/.test(un), 'state is removed by default');
  assert.ok(/rm -rf \/var\/lib\/nnm-agent/.test(uninstallScript({ purge: true })));
});

check('it says the server stays in the panel', () => {
  // The part people forget: the machine is out of the panel's reach, not out
  // of the panel.
  assert.ok(/still listed in the panel/.test(un));
});

check('the panel clears its record of the agent, and only that', () => {
  // A stored token and version describing something that is no longer there
  // is worse than no record: the panel would keep claiming an agent.
  const enroll = readFileSync(new URL('../src/routes/agentEnroll.js', import.meta.url), 'utf8');
  const route = enroll.slice(enroll.indexOf("'/agents/uninstall/ssh'"));
  assert.ok(/server\.agent\.token = ''/.test(route), 'the token is kept after removal');
  assert.ok(/server\.agent\.enabled = false/.test(route));
  assert.ok(!/deleteOne|findByIdAndDelete/.test(route), 'the server itself is deleted');
});

check('a failed removal does not clear the record', () => {
  // Otherwise the panel forgets an agent that is still running, and nothing
  // can reach it to try again.
  const enroll = readFileSync(new URL('../src/routes/agentEnroll.js', import.meta.url), 'utf8');
  const route = enroll.slice(enroll.indexOf("'/agents/uninstall/ssh'"));
  assert.ok(/if \(r\.exitCode === 0\) \{/.test(route), 'the record is cleared regardless of the outcome');
});

console.log('\nTWO AGENTS, ONE MACHINE, SEPARATE QUEUES:');

const bus = readFileSync(new URL('../src/services/agentBus.js', import.meta.url), 'utf8');
const gwRoute = readFileSync(new URL('../src/routes/agentGateway.js', import.meta.url), 'utf8');
const taskModel = readFileSync(new URL('../src/models/AgentTask.js', import.meta.url), 'utf8');

check('a task says which agent may take it', () => {
  // A gateway runs both, same binary, same server id, both polling. Without
  // this the queue handed a system change to whichever asked first — so it
  // went to the ordinary agent about half the time and came back "this agent
  // is not the privileged helper", surfacing as apply-failed with no reason.
  assert.ok(/needsPrivileged: \{ type: Boolean/.test(taskModel), 'a task cannot say who it is for');
  assert.ok(/needsPrivileged: PRIVILEGED_ROUTES\.test\(route\)/.test(bus),
    'nothing decides which tasks need the helper');
});

check('the claim filters on it, so the wrong agent cannot see the task', () => {
  // Targeted rather than retried: an ordinary agent should be incapable of
  // seeing a system task, not merely bad at running one.
  assert.ok(/needsPrivileged: isPrivileged/.test(gwRoute), 'the queue does not filter by privilege');
  assert.ok(/const isPrivileged = Boolean\(health\?\.privileged\)/.test(gwRoute),
    'the poll does not say which agent it is');
});

check('exactly the system routes need the helper', () => {
  const re = new RegExp(/const PRIVILEGED_ROUTES = (\/.*\/);/.exec(bus)[1].slice(1, -1));
  for (const r of ['POST /host/apply', 'POST /host/rollback', 'GET /host/ports']) {
    assert.ok(re.test(r), `${r} would go to the ordinary agent`);
  }
  // Reading changes nothing, so it does not need root and must not wait for a
  // helper that a media server will never have.
  for (const r of ['GET /host/readiness', 'PUT /config', 'GET /health', 'POST /media/probe']) {
    assert.ok(!re.test(r), `${r} would wait for a privileged helper`);
  }
});

check('a machine with no helper is refused at once, not after a timeout', () => {
  // A task nothing can claim sits in the queue for thirty seconds and then
  // reports a timeout — which reads as a network problem rather than a missing
  // component.
  assert.ok(/no-privileged-helper/.test(bus));
  assert.ok(/!server\.helper\?\.seen/.test(bus), 'it does not check whether a helper exists');
});

check('the helper polling is not counted as the agent restarting', () => {
  // Two instance ids alternating read as a restart every time, and that
  // counter climbed forever.
  assert.ok(/if \(!isPrivileged && seen && server\.agent\.instanceId/.test(gwRoute),
    'the restart counter still counts the two taking turns');
});

check('the failure reaches the screen with its reason', () => {
  // "apply-failed" on its own sent us looking in the wrong place for an
  // afternoon. The message underneath said exactly what was wrong.
  const ui3 = readFileSync(new URL('../../frontend/src/components/GatewaySetupModal.jsx', import.meta.url), 'utf8');
  assert.ok(/d\.detail/.test(ui3), 'the detail is discarded');
});

console.log(failures ? `\n${failures} privileged-helper check(s) failed` : '\nall privileged-helper checks passed');
process.exit(failures ? 1 : 0);
