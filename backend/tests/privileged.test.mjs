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
  assert.match(script, /BIND='127\.0\.0\.1'/);
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

check('whether the helper is present comes from the agent, not from memory', () => {
  // It can be removed with one systemctl command, and a panel reporting it
  // from its own records would keep claiming it for as long as nobody looked.
  assert.ok(/s\.agent\?\.lastHealth[\s\S]{0,120}privileged/.test(serversSrc));
  assert.ok(/privileged: PRIVILEGED/.test(readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8')),
    'the agent does not report which unit it is');
});

check('never asked is not the same as absent', () => {
  // `null` for a machine no agent has reported from: an unanswered question,
  // not a missing helper.
  assert.ok(/: null,/.test(serversSrc.slice(serversSrc.indexOf('privileged: s.agent?.lastHealth'),
                                            serversSrc.indexOf('privileged: s.agent?.lastHealth') + 200)));
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

check('the token reaches the helper as a value, not as the word for it', () => {
  // A quoted heredoc expands nothing — which is right, since the helper script
  // has $ signs of its own that must survive — but it meant the literal
  // "$AGENT_TOKEN" reached the helper's env file. It then polled the panel
  // with that string as its token, was refused, and never appeared. Nothing
  // failed loudly: the install said done, and the helper was simply absent.
  const gw2 = installScript({ panelUrl: 'http://p:8095', ticket: 'T', purpose: 'gateway' });
  const a = gw2.indexOf('PRIVEOF');
  const inner = gw2.slice(a + 8, gw2.indexOf('PRIVEOF', a + 8));
  assert.ok(!/NNM_TOKEN='\$/.test(inner), 'a shell variable name is embedded as the token');
  assert.ok(/__NNM_TOKEN__/.test(inner), 'there is no placeholder to substitute');
  assert.ok(/sed -i .*__NNM_TOKEN__/.test(gw2), 'nothing substitutes the real token on the machine');
});

check('no token means no helper, said rather than installed broken', () => {
  // Installing it with an empty token produces a service that runs, polls,
  // is refused, and looks installed — the worst of the three outcomes.
  const gw3 = installScript({ panelUrl: 'http://p:8095', ticket: 'T', purpose: 'gateway' });
  assert.ok(/no agent token yet/.test(gw3));
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

console.log(failures ? `\n${failures} privileged-helper check(s) failed` : '\nall privileged-helper checks passed');
process.exit(failures ? 1 : 0);
