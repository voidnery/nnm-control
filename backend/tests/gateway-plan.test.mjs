// Turning a machine into a gateway, iter23 m2 — the plan.
//
// The panel is about to change a system. Everything it has written until now
// went into somebody else's API, where a wrong call is refused; apt-get is not
// refused. So this is the half that must be right before anything runs, and it
// has one rule above all: the plan shown is the plan applied.
import assert from 'node:assert/strict';
import { gatewayPlan, nginxConf, acmeConf, replacePlan } from '../src/services/gatewayPlan.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures++; }
};

const free = { 80: { taken: false, holders: [] }, 443: { taken: false, holders: [] } };
const plan = (over = {}) => gatewayPlan({
  server: { name: 'gw' }, domain: 'cdn.bbesport.com', mode: 'redirect', ports: free, ...over,
});

console.log('\nNOTHING RUNS UNTIL THE PORTS ARE KNOWN:');

check('ports not checked blocks the whole plan', () => {
  // Installing nginx where something already holds 80 produces a broken
  // service rather than an error, and the operator finds out by way of an
  // outage somebody else is having.
  const p = gatewayPlan({ server: {}, domain: 'a.example.com', ports: null });
  assert.ok(p.blocking.some(x => x.code === 'ports-not-checked'));
});

check('a port that could not be read blocks, and is not treated as free', () => {
  // `ss` missing means the panel could not look. Proceeding on that is exactly
  // the assumption this project keeps refusing to make.
  const p = plan({ ports: { 80: { taken: null, holders: [] }, 443: { taken: false } } });
  assert.ok(p.blocking.some(x => x.code === 'ports-unknown' && x.port === 80));
});

check('a held port blocks and names who holds it', () => {
  // "Port 80 is taken" is not actionable. Which process, from which unit, is.
  const p = plan({ ports: {
    80: { taken: true, holders: [{ process: 'apache2', pid: 900, unit: 'apache2.service' }] },
    443: { taken: false, holders: [] },
  } });
  const b = p.blocking.find(x => x.code === 'ports-held');
  assert.equal(b.held[0].holders[0].process, 'apache2');
});

console.log('\nTHE OPERATOR IS TOLD WHAT THEY ARE AGREEING TO:');

check('a domain that is not a domain is refused', () => {
  assert.ok(gatewayPlan({ server: {}, domain: 'not a domain', ports: free }).blocking
    .some(x => x.code === 'bad-domain'));
  assert.ok(gatewayPlan({ server: {}, domain: '', ports: free }).blocking
    .some(x => x.code === 'bad-domain'));
});

check('proxy mode before the machine has joined a network is not a fault', () => {
  // The normal order of work: prepare a machine, then put it in a network.
  // Blocking here told an operator preparing a fresh VM that their brand-new
  // machine was misconfigured for not already being in a topology it cannot
  // be in yet.
  const p = plan({ mode: 'proxy', edges: [] });
  assert.deepEqual(p.blocking, [], JSON.stringify(p.problems));
  assert.equal(p.problems.find(x => x.code === 'proxy-has-no-edge-yet')?.severity, 'note');
});

check('a proxy with nowhere to forward points at something that cannot resolve', () => {
  // `edge.invalid` is a reserved TLD: a placeholder that fails loudly rather
  // than one that quietly points somewhere real.
  const c = nginxConf({ domain: 'x.example.com', mode: 'proxy', edges: [] });
  assert.match(c, /edge\.invalid/);
});

check('the plan counts what it will do, not describes it', () => {
  // Three packages and two files reads differently from "prepare the machine".
  const p = plan();
  assert.ok(p.summary.packages >= 2);
  assert.ok(p.summary.files >= 1);
  assert.ok(p.summary.commands >= 3);
});

check('every step says why it exists', () => {
  for (const s of plan().steps) assert.ok(s.why, `${s.id} has no reason`);
});

check('every step that changes something says how to undo it', () => {
  // A step that cannot say how to put things back does not belong in a plan
  // the panel presents as safe. The exception is stated: a certificate that
  // exists harms nothing and is rate-limited to replace.
  for (const s of plan().steps) {
    if (s.undo === null) {
      // The exceptions, named rather than left implicit: a certificate that
      // exists harms nothing and is rate-limited to replace, and testing a
      // configuration changes nothing at all.
      assert.ok(['issue-certificate', 'test-conf', 'test-acme-conf'].includes(s.id),
        `${s.id} changes something and cannot undo it`);
    }
  }
});

console.log('\nTHE CONFIGURATION ITSELF:');

check('the resolver line is there, with a validity', () => {
  // Without it nginx resolves an upstream once at start-up and keeps that
  // address until somebody restarts it — the failure that makes a balancer
  // worse than no balancer.
  const c = nginxConf({ domain: 'x.example.com' });
  assert.match(c, /^resolver .+ valid=/m);
});

check('HTTP/2 is on, in the spelling both nginx versions accept', () => {
  // LL-HLS requires it, and a player without it falls back to ordinary HLS in
  // silence. But `http2 on;` on its own line is nginx 1.25.1 and later, and
  // Ubuntu 24.04 ships 1.24 — where it is an unknown directive and the whole
  // configuration fails to load. `nginx -t` caught it one step before a reload
  // would have taken the machine off the air.
  //
  // The listen-line form works on both; newer nginx warns and accepts. A
  // warning on a working server beats an error on half of them, and the plan
  // cannot read the version before nginx is installed.
  const c = nginxConf({ domain: 'x.example.com' });
  assert.match(c, /listen 443 ssl http2;/);
  assert.ok(!/^\s*http2 on;/m.test(c), 'the 1.25-only directive is back');
});

check('ACME is served before the redirect, or renewal breaks', () => {
  // The other order breaks renewal the moment TLS is on.
  const c = nginxConf({ domain: 'x.example.com' });
  assert.ok(c.indexOf('acme-challenge') < c.indexOf('return 301 https'));
});

check('proxy mode resolves the edge per request', () => {
  // A literal proxy_pass to a hostname is resolved once. The variable is what
  // forces a lookup each time.
  const c = nginxConf({ domain: 'x.example.com', mode: 'proxy', edges: [{ host: 'e1', httpPort: 8081 }] });
  assert.match(c, /set \$edge/);
  assert.match(c, /proxy_pass http:\/\/\$edge/);
});

check('a bad configuration cannot reach a reload', () => {
  // Reloading nginx onto a configuration it has just rejected is how a working
  // machine stops working.
  const steps = plan().steps;
  const test = steps.findIndex(s => s.id === 'test-conf');
  const reload = steps.findIndex(s => s.id === 'reload');
  assert.ok(test < reload, 'the reload happens before the configuration is tested');
  assert.equal(steps[test].halting, true);
});

check('a stale config from a halted run is removed before the reload', () => {
  // A halt happens at `nginx -t`, which is after `enable-site` — so the
  // production config is already written and enabled when a run stops. The
  // next run then reloads nginx for the ACME phase and fails on that file,
  // with a message about a config it has not written yet.
  const ids = plan().steps.map(s2 => s2.id);
  assert.ok(ids.includes('drop-stale-site'), 'a previous run can still break the next one');
  assert.ok(ids.indexOf('drop-stale-site') < ids.indexOf('reload-for-acme'),
    'the stale config is still loaded when nginx is reloaded');
});

check('every reload is preceded by a test', () => {
  // There was a test before the final reload and none before the first, so
  // that one failed with "Job for nginx.service failed" and the reason lived
  // in the journal. nginx says what is wrong when asked, not when reloaded.
  const steps = plan().steps;
  steps.forEach((s2, i) => {
    if (!/reload/.test(s2.id)) return;
    const before = steps.slice(0, i).reverse();
    const test = before.find(x => x.command?.join(' ') === 'nginx -t');
    const anotherReload = before.findIndex(x => /reload/.test(x.id));
    const testAt = before.indexOf(test);
    assert.ok(test && (anotherReload === -1 || testAt < anotherReload),
      `${s2.id} reloads nginx without testing the configuration first`);
  });
});

check('the file step backs up before writing', () => {
  const f = plan().steps.find(s => s.kind === 'file');
  assert.equal(f.backup, true);
  assert.equal(f.undo, 'restore');
});

console.log('\nSTOPPING SOMEBODY ELSE\'S SERVICE IS ITS OWN DECISION:');

check('a unit is stopped by name and a bare process is not', () => {
  // They are not interchangeable: stopping a unit systemd will restart looks
  // like it worked and is not.
  const r = replacePlan([{ port: 80, holders: [
    { process: 'apache2', pid: 900, unit: 'apache2.service' },
    { process: 'python3', pid: 901, unit: null },
  ] }]);
  assert.deepEqual(r[0].command, ['systemctl', 'stop', 'apache2.service']);
  assert.deepEqual(r[1].command, ['kill', '901']);
});

check('a process with no unit is marked as not reversible', () => {
  // The panel cannot start it again, and the operator is agreeing to that.
  const r = replacePlan([{ port: 80, holders: [{ process: 'python3', pid: 901, unit: null }] }]);
  assert.equal(r[0].reversible, false);
  assert.equal(r[0].undo, null);
});

check('replacing is not part of the gateway plan', () => {
  // The one destructive thing here, and it is somebody else's service. It gets
  // its own consent rather than riding along inside a longer list.
  assert.ok(!plan().steps.some(s => /stop-|kill/.test(s.id)));
});

console.log('\nTHE AGENT EXECUTES WHAT IT IS SENT, AND NOTHING ELSE:');

const { readFileSync } = await import('node:fs');
const agent = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
const apply = agent.slice(agent.indexOf("'POST /host/apply'"), agent.indexOf("'POST /host/rollback'"));

check('it composes no commands of its own', () => {
  // The whole safety of this: what an operator approved and what runs are the
  // same objects. An agent that builds its own commands from a domain would be
  // a remote shell with extra ceremony.
  assert.ok(/step\.command/.test(apply), 'the command does not come from the step');
  for (const invented of ['apt-get', 'certbot', 'nginx -t', 'systemctl reload']) {
    assert.ok(!apply.includes(invented), `the agent has "${invented}" written into it`);
  }
});

check('only recognised shapes run', () => {
  // A step kind it does not know is refused rather than attempted.
  assert.ok(/unknown step kind/.test(apply));
  assert.ok(/step\.kind === 'package' \|\| step\.kind === 'command'/.test(apply));
});

check('still no shell', () => {
  assert.ok(!/promisify\(exec\)\(|shell:\s*true|execSync/.test(agent), 'a shell reached the agent');
  assert.ok(/execFile\(file, args/.test(agent));
});

check('a file is copied before it is written, and the copy is reported', () => {
  // A rollback that cannot say what it would restore is a promise, not a
  // mechanism.
  assert.ok(/\.nnm-\$\{Date\.now\(\)\}\.bak/.test(apply), 'no backup is taken');
  assert.ok(/backup,/.test(apply), 'the backup path is not returned');
  assert.ok(!/fs\.rename/.test(apply), 'the original is moved, leaving the path missing in between');
});

check('a halting failure stops everything after it', () => {
  // Continuing past `nginx -t` is how a working machine stops working.
  assert.ok(/if \(step\.halting !== false\) \{ halted = step\.id; break; \}/.test(apply));
});

check('a non-zero exit is a failure, not silence', () => {
  // `run` swallows the code, which is right for reading and wrong for doing:
  // a package install that fails must not look like one with no output.
  assert.ok(/out\.code !== 0/.test(apply));
  assert.ok(/runFull/.test(apply), 'the doing path uses the reading helper');
});

console.log('\nAPPLYING RE-PLANS, AND VERIFIES BY BEING A CLIENT:');

const routes = readFileSync(new URL('../src/routes/servers.js', import.meta.url), 'utf8');
// Sliced by the route path as it is declared. It changed when the duplicated
// mount prefix was removed, and a slice anchored on the old string silently
// became empty — so these checks passed against nothing until the suite said
// otherwise.
const applyRoute = routes.slice(routes.indexOf("'/:id/gateway/apply'"), routes.indexOf("'/:id/gateway/rollback'"));
if (!applyRoute) throw new Error('the apply route could not be located; these checks would test nothing');

check('the plan is recomputed at apply, not taken from the request', () => {
  // If the machine moved between the preview and the press, the operator
  // approved something else.
  assert.ok(/gatewayPlan\(\{ server, domain, mode, edges, ports/.test(applyRoute));
  assert.ok(/plan\.blocking\.length/.test(applyRoute), 'a blocked plan is applied anyway');
});

check('ports are re-read rather than remembered', () => {
  // Something can start listening between a plan and a press, and this is the
  // check whose staleness breaks somebody else's service.
  // With the method, because that is what the agent bus dispatches on. This
  // assertion matched the path alone and therefore passed against every one of
  // the five calls that were missing their method — the task never reached a
  // handler and the panel reported "the agent did not answer" about an agent
  // answering perfectly well.
  assert.ok(/'GET \/host\/ports'/.test(applyRoute), 'the ports task has no method and will never dispatch');
});

check('every agent task names a method, as the bus dispatches on one', () => {
  // `task.route.split(' ')[0]` is the method; a route without one produces a
  // key no handler matches, an empty result, and a panel blaming the agent.
  // Five calls shipped this way.
  for (const m of routes.matchAll(/runTask\([^,]+,\s*'([^']+)'/g)) {
    assert.match(m[1], /^(GET|POST|PUT|PATCH|DELETE) \//,
      `runTask("${m[1]}") has no method`);
  }
});

check('only steps the plan produced are sent', () => {
  assert.ok(/plan\.steps\.filter\(s => wanted\.has\(s\.id\)\)/.test(applyRoute));
});

check('success is a handshake, not an exit code', () => {
  // Every step can return zero and the machine still not serve — the same
  // rule as delivery, and the reason the panel fetches playlists rather than
  // reading configurations.
  assert.ok(/probeTls\(domain, 443\)/.test(applyRoute));
});

check('an agent too old is refused before anything runs', () => {
  assert.ok(/agent-too-old/.test(applyRoute));
});

console.log('\nWHAT THE AGENT IS NOT ALLOWED TO DO IS SAID, NOT SHOWN AS NOISE:');

const { readFileSync: rf } = await import('node:fs');
const agentSrc = rf(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
const ui = rf(new URL('../../frontend/src/components/GatewaySetupModal.jsx', import.meta.url), 'utf8');
const cards = rf(new URL('../../frontend/src/pages/ServerAgentsPage.jsx', import.meta.url), 'utf8');
const d = rf(new URL('../../frontend/src/i18n.jsx', import.meta.url), 'utf8');

check('a refusal by the sandbox is recognised, not passed through as apt output', () => {
  // The agent runs as its own user under ProtectSystem=strict — deliberately,
  // because on fifteen media servers it needs two directories and an agent
  // that could install packages would be root across the fleet. So a system
  // change fails by design, as a wall of complaints about read-only
  // filesystems, and the operator reads it as a broken machine.
  assert.ok(/sandboxed = true|e\.sandboxed = true/.test(agentSrc), 'the agent does not recognise its own sandbox');
  assert.ok(/read-only file system/i.test(agentSrc));
  assert.ok(/gw\.setup\.sandboxed/.test(ui), 'the panel does not explain it');
  assert.equal((d.match(/'gw\.setup\.sandboxedWhy':/g) || []).length, 2);
});

check('the explanation says what to do instead of only what happened', () => {
  const ru = d.slice(d.indexOf("'gw.setup.sandboxedWhy'"), d.indexOf("'gw.setup.sandboxedWhy'") + 700);
  assert.ok(/вручную|by hand/.test(ru), 'the operator is told the cause and left there');
});

console.log('\nA PREPARED MACHINE SAYS SO:');

check('the state is recorded on failure as well as on success', () => {
  // A failed attempt is a fact about this machine, and forgetting it is how
  // the same wall gets walked into twice.
  const routes2 = rf(new URL('../src/routes/servers.js', import.meta.url), 'utf8');
  assert.ok(/state: result\?\.ok \? 'applied' : sandboxed \? 'refused-by-sandbox' : 'failed'/.test(routes2));
  assert.ok(/\/\/ Saved either way/.test(routes2), 'the state is only saved when it worked');
});

check('the card shows it, not only the dialog that did it', () => {
  // Otherwise a gateway that is serving and one created five minutes ago and
  // never touched look identical in a list.
  assert.ok(/s\.gateway\?\.state/.test(cards));
  for (const st of ['applied', 'failed', 'refused-by-sandbox', 'none']) {
    assert.equal((d.match(new RegExp(`'agent\\.gw\\.${st}':`, 'g')) || []).length, 2, st);
  }
});

console.log('\nRUNNING LOOKS LIKE RUNNING:');

check('there is a bar while it runs, and it claims no percentage', () => {
  // It sat grey and silent for as long as apt took, which is
  // indistinguishable from a hang — and the one thing anybody does with a
  // hung screen is press the button again.
  const css = rf(new URL('../../frontend/src/styles.css', import.meta.url), 'utf8');
  assert.ok(/busy && !result/.test(ui), 'nothing is shown while it runs');
  assert.ok(/indeterminate/.test(ui) && /@keyframes indeterminate/.test(css));
  assert.ok(/prefers-reduced-motion[\s\S]{0,200}indeterminate/.test(css), 'the animation has no reduced-motion escape');
});

check('the plan opens in its own window', () => {
  // Inline it pushed the buttons off the bottom of an already long dialog, so
  // the thing to read before deciding was the thing to scroll past to decide.
  assert.ok(/showPlan && plan/.test(ui));
});

console.log('\nWORK THAT TAKES MINUTES IS NOT ONE REQUEST:');

const uiPoll = readFileSync(new URL('../../frontend/src/components/GatewaySetupModal.jsx', import.meta.url), 'utf8');
const dict2 = readFileSync(new URL('../../frontend/src/i18n.jsx', import.meta.url), 'utf8');

check('the apply answers at once and is polled after', () => {
  // Installing nginx and issuing a certificate takes minutes. Held open, the
  // request returned 504 from whatever proxies the panel — while the work
  // carried on underneath and finished. The install flow solved this with a
  // job long ago; this one was written synchronously and should not have been.
  // The condition, not just the presence of the line. `if (false)` leaves the
  // 202 in the file and unreachable, and a check that matches text alone
  // passes on it — which it did.
  assert.ok(/if \(req\.body\?\.async !== false\) \{/.test(routes),
    'the job path is not the default, so an apply can still block until it finishes');
  assert.ok(/res\.status\(202\)\.json\(\{ jobId/.test(routes), 'nothing returns a job');
  assert.ok(/gateway\/jobs\/:jobId/.test(routes), 'there is nothing to poll');
  assert.ok(/gateway\/jobs\/\$\{started\.jobId\}/.test(uiPoll), 'the dialog does not poll');
});

check('the machine is recorded from the job, not from the request', () => {
  // The request is gone by then. If the state were written where the response
  // is built, a preparation that outlived its own request would leave the
  // panel believing nothing had happened.
  const job = routes.slice(routes.indexOf('const jobId = createJob('), routes.indexOf('return res.status(202)'));
  assert.ok(/server\.gateway = \{/.test(job), 'the gateway state is not recorded inside the job');
  assert.ok(/probeTls\(domain, 443\)/.test(job), 'success is still declared without a handshake');
});

check('its output is shown while it runs', () => {
  // An animation and nothing else for four minutes is indistinguishable from
  // a hang, which is what the bar was added to avoid in the first place.
  assert.ok(/setProgress\(job\.output/.test(uiPoll));
});

console.log('\nOUR OWN NGINX IS NOT A CONFLICT:');

check('nginx from a previous run does not block the next one', () => {
  // The first run installed it; blocking on our own successful work is absurd,
  // and it is exactly what happened. A second run is a reload, not a refusal.
  const p2 = plan({ ports: {
    80: { taken: true, holders: [{ process: 'nginx', pid: 71916, unit: 'nginx.service' }] },
    443: { taken: false, holders: [] },
  } });
  assert.ok(!p2.blocking.some(x => x.code === 'ports-held'), 'our own nginx blocks the plan');
  assert.ok(p2.problems.some(x => x.code === 'nginx-already-here' && x.severity === 'note'),
    'and nothing says why the ports are busy');
});

check('anything else on those ports still blocks', () => {
  const p2 = plan({ ports: {
    80: { taken: true, holders: [{ process: 'apache2', pid: 900, unit: 'apache2.service' }] },
    443: { taken: false, holders: [] },
  } });
  assert.ok(p2.blocking.some(x => x.code === 'ports-held'));
});

check('a mix reports only the ones that are not ours', () => {
  const p2 = plan({ ports: {
    80: { taken: true, holders: [
      { process: 'nginx', pid: 1, unit: 'nginx.service' },
      { process: 'apache2', pid: 2, unit: 'apache2.service' },
    ] },
    443: { taken: false, holders: [] },
  } });
  const held = p2.blocking.find(x => x.code === 'ports-held').held;
  assert.deepEqual(held[0].holders.map(h => h.process), ['apache2']);
});

console.log('\nAND THE OPERATOR CAN CLEAR THEM:');

const freeRoute = routes.slice(routes.indexOf("'/:id/gateway/free-ports'"));

check('there is an action, not only an explanation', () => {
  // I built the plan for this and wired no button, on the grounds that
  // stopping somebody else's service should not happen behind a Next button.
  // That was my judgement substituted for the operator's, who had asked for
  // the choice.
  assert.ok(/gateway\/free-ports/.test(routes), 'nothing can free the ports');
  assert.ok(/free-ports/.test(uiPoll), 'the dialog offers no way to do it');
  assert.ok(/stopPids/.test(uiPoll), 'processes are not ticked individually');
});

check('only the pids the operator confirmed', () => {
  // Ticked by hand, one box per process. Offering the choice is not the same
  // as making it easy to make carelessly.
  assert.ok(/const confirmed = new Set\(\(req\.body\?\.pids/.test(freeRoute));
  assert.ok(/nothing-confirmed/.test(freeRoute), 'an empty selection would stop everything');
});

check('the list is re-read before anything is stopped', () => {
  // The list the operator saw is a minute old at best, and a stale pid can
  // name something that has since started.
  assert.ok(/'GET \/host\/ports'/.test(freeRoute), 'it acts on the list from the request');
});

check('a process with no unit is marked as unrecoverable in the UI', () => {
  // The panel cannot start it again, and that is the part somebody needs
  // before ticking rather than after.
  assert.ok(/gw\.setup\.noUnitWarn/.test(uiPoll));
});

check('the audit says what was stopped and what cannot come back', () => {
  assert.ok(/irreversible: steps\.filter/.test(freeRoute));
});

console.log('\nTHE CERTIFICATE IS ISSUED THROUGH NGINX, NOT AGAINST IT:');

check('certbot uses the running nginx rather than binding 80 itself', () => {
  // `--standalone` binds port 80, and fails the moment anything is already
  // there — which this plan made sure of three steps earlier by installing
  // nginx. Stopping nginx to issue and starting it again would take the
  // machine down twice per renewal.
  const cert = plan().steps.find(s2 => s2.id === 'issue-certificate');
  assert.ok(!cert.command.includes('--standalone'), 'certbot competes with the nginx it just installed');
  assert.ok(cert.command.includes('--webroot'), 'certbot has no way to answer the challenge');
});

check('something answers the challenge before it is asked for', () => {
  // And it is a config this plan wrote, not the distribution's default site:
  // depending on a file nobody here controls is how this works on one image
  // and not another.
  const ids = plan().steps.map(s2 => s2.id);
  for (const needed of ['write-acme-conf', 'enable-acme', 'reload-for-acme']) {
    assert.ok(ids.includes(needed), `${needed} is missing`);
  }
  assert.ok(ids.indexOf('reload-for-acme') < ids.indexOf('issue-certificate'),
    'nginx is not serving the challenge when certbot asks for it');
});

check('the real config comes after the certificate exists', () => {
  // It names the certificate files, and nginx refuses to load a config
  // pointing at a file that is not there — so writing it first would fail the
  // test step and halt the plan.
  const ids = plan().steps.map(s2 => s2.id);
  assert.ok(ids.indexOf('issue-certificate') < ids.indexOf('write-conf'),
    'the real config is written before the certificate it references');
});

check('the temporary block is removed once the real one is in', () => {
  // Two server blocks for one name on port 80 is one too many, and leaving
  // debris behind is how a machine becomes unreadable.
  const ids = plan().steps.map(s2 => s2.id);
  assert.ok(ids.includes('drop-acme-conf'));
  assert.ok(ids.indexOf('drop-acme-conf') < ids.indexOf('test-conf'),
    'the configuration is tested with both blocks present');
});

check('the ACME block serves the challenge and refuses everything else', () => {
  const c = acmeConf({ domain: 'x.example.com' });
  assert.match(c, /location \/\.well-known\/acme-challenge\/ \{ root \/var\/www\/html; \}/);
  assert.match(c, /return 404/);
  assert.ok(!/ssl_certificate/.test(c), 'it references a certificate that does not exist yet');
});

console.log('\nWHY A CHALLENGE WOULD FAIL, BEFORE SPENDING ONE:');

const agentSrc2 = readFileSync(new URL('../src/assets/nnm-agent.mjs', import.meta.url), 'utf8');
// Bounded by the handler's own end rather than by a character count: adding
// four lines to the handler pushed `unlink` past a fixed 3000 and the check
// reported the probe file as left behind. A slice measured in characters
// measures the wrong thing.
const preStart = agentSrc2.indexOf("'POST /host/acme-precheck'");
const pre = agentSrc2.slice(preStart, agentSrc2.indexOf('\n  },', preStart));

check('the machine checks itself, because nobody else can', () => {
  // certbot puts the reason in a log file on a box nobody is sitting at, and
  // checking the domain from anywhere else answers a different question: an
  // operator's network may reach it when Let's Encrypt cannot, or the reverse.
  assert.ok(/acme-precheck/.test(agentSrc2), 'nothing can test the challenge path');
  assert.ok(/dns\/promises/.test(pre), 'it does not check whether the name resolves');
  assert.ok(/api\.ipify\.org|publicIp/.test(pre), 'it does not learn its own public address');
});

check('it writes a real challenge file and fetches it by name', () => {
  // The only check covering the whole path: nginx config, firewall, and
  // whatever sits in front of the machine. Each of those fails differently and
  // certbot calls all of them "some challenges have failed".
  assert.ok(/acme-challenge/.test(pre) && /writeFile/.test(pre), 'no challenge file is written');
  assert.ok(/http:\/\/\$\{domain\}/.test(pre), 'it fetches by address rather than by name');
  assert.ok(/unlink/.test(pre), 'the probe file is left behind');
});

check('the precheck runs after nginx is up and before the certificate', () => {
  // It sat ahead of every step, so on a clean machine it asked a domain
  // nothing was serving yet and got "connection refused" — a correct answer to
  // a question asked too early. It only ever passed where a previous attempt
  // had left nginx behind, which is why it looked fine for days.
  assert.ok(/const certAt = steps\.findIndex\(x => x\.id === 'issue-certificate'\)/.test(routes),
    'the steps are not split at the certificate');
  const job = routes.slice(routes.indexOf('const certAt'), routes.indexOf('finishJob(jobId, { status: r?.ok'));
  assert.ok(job.indexOf('steps: before') < job.indexOf("'POST /host/acme-precheck'"),
    'the domain is checked before anything serves it');
  assert.ok(job.indexOf("'POST /host/acme-precheck'") < job.indexOf('steps: after'),
    'the certificate is issued before the domain is checked');
});

check('a failing precheck stops before the certificate and says why', () => {
  // Let's Encrypt rate-limits failures, so an attempt that cannot succeed is
  // worth not making — and each fault has its own sentence rather than all of
  // them arriving as one.
  const job = routes.slice(routes.indexOf('const certAt'));
  assert.ok(/stopping before the certificate/.test(job));
  for (const fragment of ['does not resolve', 'points at', 'cannot enter', 'not from the panel']) {
    assert.ok(job.includes(fragment), `"${fragment}" is not distinguished`);
  }
});

check('a stop before the certificate does not undo what worked', () => {
  // nginx is installed and serving the challenge; throwing that away would
  // mean starting from nothing after fixing a DNS record.
  const job = routes.slice(routes.indexOf('const certAt'));
  assert.ok(/nothing was rolled back/.test(job), 'the operator is not told the work survives');
  assert.ok(!/rollback/.test(job.slice(0, job.indexOf('finishJob'))), 'it rolls back on a precheck failure');
});

check('a probe that could not run is a failure, not a pass', () => {
  // `challengeServed` was left undefined when the fetch threw or the file
  // could not be written, and the guard tested `=== false` — so a check that
  // did not happen read as a check that found nothing wrong, and the apply
  // walked on to certbot. Written by me, in the code added to prevent exactly
  // this.
  assert.ok(/challengeServed !== true/.test(routes), 'an undefined result passes as a success');
  const pre2 = pre;
  assert.equal((pre2.match(/out\.challengeServed = false/g) || []).length, 2,
    'the agent leaves the field undefined on one of its failure paths');
});

check('the challenge is fetched from a second network as well', () => {
  // A machine cannot prove it is reachable from the internet by asking itself:
  // the request loops back locally or leaves and returns through the same
  // firewall that would have let it. Let's Encrypt comes from outside, and
  // this check was passing while certbot failed on that very leg.
  assert.ok(/acme\.fromPanel/.test(routes), 'only the machine is asked');
  assert.ok(/acme\?\.token/.test(routes), 'the panel has no file to fetch');
  assert.ok(/keptForSeconds|setTimeout/.test(agentSrc2), 'the probe file is deleted before the panel can look');
});

check('the probe says which directory blocks the path', () => {
  // Reading four modes and reasoning about them is how the wrong directory got
  // fixed twice: /var/www/html was opened by hand while /var/www stayed 0700,
  // and the 403 was byte-identical. The agent walks the path and names the
  // first one nginx cannot enter.
  assert.ok(/pathClosedAt/.test(agentSrc2), 'the probe does not check traversal');
  assert.ok(/0o001/.test(pre), 'it checks readability rather than traversal');
  assert.ok(/cannot enter \$\{acme\.pathClosedAt\}/.test(routes), 'the panel does not distinguish it');
});

check('answering itself but not the panel has its own name', () => {
  // "not served" would send somebody to look at nginx, and nginx is fine —
  // the port is closed between the two networks.
  assert.ok(/answered here but not from the panel/.test(routes));
});

check('a helper too old to check is named before the steps run', () => {
  // It silently did not happen — the helper was v24, the endpoint arrived in
  // v25, and the operator watched certbot fail with the sentence the precheck
  // exists to replace. A check that quietly does not occur is worse than none:
  // it leaves somebody believing the domain was verified.
  // While there is still time to stop and update it, rather than after the
  // domain has been blamed for something that is a fact about the fleet.
  assert.ok(/will not be pre-checked/.test(routes), 'a skipped precheck leaves no trace');
  assert.ok(/\(server\.helper\?\.version \?\? 0\) < 25/.test(routes),
    'nothing decides whether the check is even possible');
  // And told apart by the helper's version rather than both being reported as
  // a failure: an agent that has no such endpoint is a fact about the fleet,
  // and "reinstall the helper" is a different instruction from "the call
  // broke". Checking that both strings exist somewhere was not enough — the
  // condition choosing between them is the thing.
  // Two situations, two places, two sentences: a helper too old is announced
  // before the steps, while there is time to update it; a call that broke
  // mid-run is reported where it broke. Merging them would send somebody to
  // reinstall a helper that is fine.
  assert.ok(/will not be pre-checked/.test(routes), 'an old helper is not announced');
  assert.ok(/could not be pre-checked/.test(routes), 'a broken call has no message of its own');
  const job = routes.slice(routes.indexOf('const jobId = createJob('), routes.indexOf('return res.status(202)'));
  assert.ok(job.indexOf('will not be pre-checked') < job.indexOf("runTask(server, 'POST /host/apply'"),
    'it is said after the steps have already run');
});

check('an unreachable helper does not block the apply', () => {
  // The precheck is help, not a gate on its own behalf: a helper that cannot
  // answer it must not stop a preparation that would have worked.
  const job = routes.slice(routes.indexOf('const certAt'));
  assert.ok(/could not be pre-checked/.test(job), 'a failed call is treated as a failed domain');
  assert.ok(/if \(acme && \(acme\.challengeServed !== true/.test(job),
    'a missing precheck result blocks the certificate');
});

console.log('\nTHE MACHINE LIST IS NOT EMPTY ON EVERY FLEET:');

const gwPanel = readFileSync(new URL('../../frontend/src/components/GatewayPanel.jsx', import.meta.url), 'utf8');

check('the servers list says whether a machine has an agent', () => {
  // The dropdown filtered on `s.agent?.enabled`, which /servers never sent —
  // so it was empty on every fleet, including one with a gateway prepared and
  // proved that morning. A field nobody sends is indistinguishable from a
  // fleet with no agents.
  assert.ok(/hasAgent: Boolean\(s\.agent\?\.enabled\)/.test(routes), 'the list omits hasAgent');
  assert.ok(/agent: s\.agent\?\.enabled \? \{/.test(routes), 'the list omits the agent itself');
});

check('every field the delivery page filters on is actually sent', () => {
  // Bound to the consumer rather than to a literal: the filter and the
  // response are in different files and were wrong together for weeks.
  const filters = [...gwPanel.matchAll(/s\.(\w+)\?\.\w+|s\.(\w+)\b/g)]
    .map(m => m[1] || m[2])
    .filter(n => ['agent', 'hasAgent', 'purpose', 'gateway', 'id', 'name'].includes(n));
  for (const field of new Set(filters)) {
    // Searched inside the response builder, not the whole file, and allowing
    // the leading whitespace the object literal actually has. Matching
    // `^\\s*name:` against the file found `name` in a dozen unrelated places
    // and missed it in the one that mattered — a check reporting a fault in
    // correct code, which is how checks get switched off.
    const i = routes.indexOf('const pub = (s) => ({');
    const body = routes.slice(i, routes.indexOf('\n});', i));
    assert.ok(new RegExp(`(^|\\s)${field}:`).test(body),
      `GatewayPanel reads s.${field} and /servers does not send it`);
  }
});

check('edge-proxy machines are listed apart from media servers', () => {
  // Different machines doing different jobs: an edge-proxy has no Nimble and
  // exists to hand viewers on, while a Nimble box can host a gateway and is
  // also serving video from the same ports. One list invites putting a gateway
  // on a media server without noticing.
  assert.ok(/=== 'gateway'\)/.test(gwPanel), 'the list is not split by purpose');
  assert.ok(/optgroup/.test(gwPanel), 'the split is not visible');
  assert.equal((dict2.match(/'gw\.group\.proxy':/g) || []).length, 2);
});

check('an empty list explains itself', () => {
  // It was empty on every fleet and nothing on the screen said why.
  assert.ok(/!withAgent\.length/.test(gwPanel), 'an empty dropdown is left unexplained');
  assert.equal((dict2.match(/'gw\.noNodes':/g) || []).length, 2);
});

console.log('\nAN ADDRESS COMES FROM THE OPERATOR, NOT FROM WMSPANEL:');

const chRoutes = readFileSync(new URL('../src/routes/channels.js', import.meta.url), 'utf8');
const chLinks = readFileSync(new URL('../src/services/channelLinks.js', import.meta.url), 'utf8');
const chPanel = readFileSync(new URL('../../frontend/src/components/ChannelsPanel.jsx', import.meta.url), 'utf8');

check('the Host field outranks a name synced from WMSPanel', () => {
  // The order was the other way round, so when two edges changed address and
  // their DNS had not caught up, the panel kept handing viewers the stale name
  // — while the Host field, which the operator had corrected, was never
  // consulted. WMSPanel's domains are a fact about WMSPanel; the Host field is
  // the operator saying where the machine is.
  const m = /publicHost: ([^,]+),/.exec(chRoutes);
  assert.ok(m, 'nothing decides the public host');
  const order = m[1];
  assert.ok(order.indexOf('s.host') < order.indexOf('wmspanelDomains'),
    `WMSPanel outranks the operator: ${order}`);
});

check('every address a machine answers on is offered', () => {
  // One name was baked into each test link. When its DNS was stale there was
  // nothing to switch to, though the machine answered on its address the whole
  // time — and the panel cannot know which resolves correctly today.
  assert.ok(/hosts: \[\.\.\.new Set\(/.test(chRoutes), 'only one address is sent');
  assert.ok(/urls: \(e\.hosts/.test(chLinks), 'the links are built for one address');
  assert.ok(/pickedHost/.test(chPanel), 'the operator cannot choose');
});

check('the choice is not remembered', () => {
  // It is a question about right now: tomorrow the stale name may be the
  // working one, and a remembered pick would quietly outlive its reason.
  assert.ok(!/localStorage|api\(.*pickedHost/.test(chPanel), 'the picked address is persisted');
});

console.log('\nTHE FORM SHOWS WHAT WAS SAVED:');

const gwPanel2 = readFileSync(new URL('../../frontend/src/components/GatewayPanel.jsx', import.meta.url), 'utf8');

check('the gateway form follows a reloaded network', () => {
  // `useState` runs once. The parent reloads after a save and passes the new
  // network down, but the component was already mounted — so it kept showing
  // what had been typed, and reopening the page showed something else again.
  // Saved correctly, displayed from a stale copy.
  assert.ok(/useEffect\(\(\) => \{ setGw\(network\.gateway/.test(gwPanel2),
    'the form never re-reads the network it was given');
  assert.ok(/\[network\.id, savedKey\]/.test(gwPanel2),
    'the effect does not depend on the saved gateway, so a save does not refresh it');
});

check('choosing a prepared machine fills in the domain it was prepared with', () => {
  // Otherwise it is retyped from another page, which is where typos come from.
  assert.ok(/picked\?\.gateway\?\.domain/.test(gwPanel2), 'the domain is not offered');
  assert.ok(/gw\.domain \|\| picked/.test(gwPanel2), 'it overwrites what the operator typed');
});

console.log('\nTHE NETWORK SENDS ITS GATEWAY:');

const netRoutes = readFileSync(new URL('../src/routes/cdnNetworks.js', import.meta.url), 'utf8');
const arbRoutes = readFileSync(new URL('../src/routes/arbiter.js', import.meta.url), 'utf8');
const resyncModule = await import('../src/services/gatewayResync.js');

check('the networks list includes the gateway settings', () => {
  // The panel initialises its form from `network.gateway`, and this list never
  // sent it — so the form was empty no matter what had been saved, and
  // reopening the page showed the saved value gone. I fixed the form twice
  // before checking whether the field was ever sent. Second time in two days:
  // a field nobody sends looks exactly like a field nobody set.
  const i = netRoutes.indexOf('const pub = (n) => ({');
  const body = netRoutes.slice(i, netRoutes.indexOf('\n});', i));
  assert.ok(/(^|\s)gateway:/.test(body), 'the networks list omits the gateway');
  for (const field of ['mode', 'node', 'domain', 'policy', 'whenAllDown']) {
    assert.ok(body.includes(`${field}:`), `the gateway is sent without ${field}`);
  }
});

check('the node is a string, so a select can match it', () => {
  // An ObjectId does not equal the option value the panel renders.
  const i = netRoutes.indexOf('const pub = (n) => ({');
  const body = netRoutes.slice(i, netRoutes.indexOf('\n});', i));
  assert.ok(/node: n\.gateway\.node \? String\(/.test(body), 'the node is not stringified');
});

console.log('\nA MACHINE PREPARED BEFORE THE EDGES SAYS SO:');

check('changing the network rewrites the edge-proxy, rather than reporting it', () => {
  // The config names the edges and was written during preparation, which
  // happens before a machine joins a network — so it pointed at a placeholder.
  // The previous version detected this and asked the operator to press a
  // button on another page: a fact the panel holds, a change only the panel
  // can make, and a person sent to do it by hand.
  const netRoutes2 = readFileSync(new URL('../src/routes/cdnNetworks.js', import.meta.url), 'utf8');
  assert.ok(/resyncGateway\(\{ network: n/.test(netRoutes2),
    'changing which machines are edges leaves the gateway pointing at the old ones');
  assert.ok(/resyncGateway\(\{ network: n/.test(arbRoutes),
    'saving the gateway settings does not bring the machine into step');
});

check('edge addresses come from the machines, not from the network nodes', () => {
  // A node holds a reference to a machine and nothing else — no host, no port.
  // Reading `n.host` off it gave undefined for every edge, the filter dropped
  // them all, and the config was rewritten with none. The panel then reported
  // "edge in the config — 0", which was true, cheerful, and a gateway
  // forwarding viewers nowhere.
  const resyncSrc = readFileSync(new URL('../src/services/gatewayResync.js', import.meta.url), 'utf8');
  assert.ok(/NimbleServer\.find\(\{ _id: \{ \$in: edgeIds \}/.test(resyncSrc),
    'the machines behind the edge nodes are never loaded');
  assert.ok(!/n\.publicHost \|\| n\.host/.test(resyncSrc),
    'it still reads an address off a node that has none');
  // Same order as the delivery page, so one machine does not resolve to two
  // different addresses depending on which page asked.
  assert.ok(/m\.playbackEndpoints\?\.\[0\]\?\.host \|\| m\.host \|\| m\.wmspanelDomains/.test(resyncSrc),
    'the address order differs from the one the links use');
});

check('the resync writes the mode the operator chose', () => {
  // Hard-coded to proxy, it wrote a proxy config whichever mode was selected —
  // and refused redirect outright, so switching the mode left the machine
  // serving the previous one. The operator selected redirect, watched the
  // stream keep working, and was watching proxy: a player follows a 302
  // without saying so, and only the HTTP response tells the two apart.
  const resyncSrc = readFileSync(new URL('../src/services/gatewayResync.js', import.meta.url), 'utf8');
  assert.ok(/mode: gw\.mode/.test(resyncSrc), 'the resync writes a mode of its own choosing');
  assert.ok(!/mode: 'proxy'/.test(resyncSrc), 'a mode is still hard-coded');
  assert.ok(/\['proxy', 'redirect'\]\.includes\(gw\.mode\)/.test(resyncSrc),
    'one of the two modes that write a config is refused');
});

check('the config reads no variable it does not define', () => {
  // `$nnm_edge` was read once and defined nowhere. nginx refuses a
  // configuration that reads an unknown variable, so redirect mode had never
  // been valid — unnoticed because nothing applied it until the resync learned
  // to write it, and then `nginx -t` caught it one step before the reload.
  //
  // nginx's own variables are fine; anything this file invents must be defined
  // in it.
  const BUILTIN = new Set(['scheme', 'host', 'request_uri', 'uri', 'args', 'remote_addr',
    'http_host', 'proxy_add_x_forwarded_for', 'server_name', 'status', 'body_bytes_sent',
    'http_user_agent', 'http_referer', 'request', 'time_local', 'upstream_addr',
    'upstream_cache_status', 'request_method', 'document_root', 'is_args']);
  for (const mode of ['proxy', 'redirect']) {
    const c = nginxConf({ domain: 'x.example.com', mode, edges: [{ name: 'e', host: '1.2.3.4', httpPort: 8081 }] });
    const used = new Set([...c.matchAll(/\$([a-z_][a-z0-9_]*)/gi)].map(m => m[1]));
    const defined = new Set([...c.matchAll(/(?:set|map[^;]*?)\s+\$([a-z_][a-z0-9_]*)/gi)].map(m => m[1]));
    for (const v of used) {
      if (BUILTIN.has(v) || defined.has(v)) continue;
      assert.fail(`${mode} mode reads $${v}, which nothing defines — nginx will refuse the file`);
    }
  }
});

check('a redirect names a real edge, or an address that cannot resolve', () => {
  // Same rule as proxy: a placeholder must fail loudly rather than quietly
  // point somewhere real.
  // Without a TLS handshake on that edge the scheme is http, which is what
  // 8081 actually speaks — the assertion used to require `$scheme` here, the
  // very thing that sent viewers to https on a plain-HTTP port.
  const withEdge = nginxConf({ domain: 'x.example.com', mode: 'redirect', edges: [{ name: 'e', host: '1.2.3.4', httpPort: 8081 }] });
  assert.match(withEdge, /return 302 http:\/\/1\.2\.3\.4:8081\$request_uri;/);
  const without = nginxConf({ domain: 'x.example.com', mode: 'redirect', edges: [] });
  assert.match(without, /edge\.invalid/);
});

check('a redirect names a scheme the edge actually answers on', () => {
  // `$scheme` inherits how the viewer arrived, so a viewer on https was sent
  // to https://<edge>:8081 — plain HTTP behind a TLS scheme. The connection
  // died at the handshake and the player reported only that it could not open
  // the source. Proxy mode hid this entirely: it dials the edge itself, over
  // HTTP, so how the viewer arrived never mattered.
  //
  // A redirect is an address somebody else will dial, so every part of it has
  // to be true of the machine at the other end.
  const line = (edges) => nginxConf({ domain: 'x.example.com', mode: 'redirect', edges })
    .split('\n').find(l => l.includes('return 302'));

  assert.match(line([{ name: 'e', host: '1.2.3.4', httpPort: 8081, httpsPort: 0 }]),
    /return 302 http:\/\/1\.2\.3\.4:8081/);
  assert.match(line([{ name: 'e', host: 'edge.example.com', httpPort: 8081, httpsPort: 443 }]),
    /return 302 https:\/\/edge\.example\.com\$request_uri/);
  // A non-standard TLS port is named; 443 is not, because naming it is noise
  // and a viewer copying the URL out of a log should see what they would type.
  assert.match(line([{ name: 'e', host: 'edge.example.com', httpPort: 8081, httpsPort: 8443 }]),
    /https:\/\/edge\.example\.com:8443/);
  // And no inherited scheme anywhere in the redirect.
  for (const e of [[], [{ name: 'e', host: 'h', httpPort: 8081, httpsPort: 0 }]]) {
    assert.ok(!/\$scheme/.test(line(e)), 'the redirect still inherits the viewer scheme');
  }
});

check('the TLS answer comes from a handshake, not from a port being set', () => {
  // `httpsPort` is where the operator says TLS would be; `tls.tls` is whether
  // the panel got one. Trusting the first alone sends viewers to a port
  // nothing is listening on.
  const resyncSrc = readFileSync(new URL('../src/services/gatewayResync.js', import.meta.url), 'utf8');
  assert.ok(/m\.tls\?\.tls \? \(m\.httpsPort \|\| 443\) : 0/.test(resyncSrc),
    'the edge scheme is decided without a handshake');
});

check('the two modes produce configs that differ where it matters', () => {
  // Not a cosmetic difference: proxy carries the media and hides the edges,
  // redirect hands the viewer an address and carries nothing. A resync that
  // writes the wrong one changes what the whole delivery path does.
  const proxy = nginxConf({ domain: 'x.example.com', mode: 'proxy', edges: [{ name: 'e', host: '1.2.3.4', httpPort: 8081 }] });
  const redirect = nginxConf({ domain: 'x.example.com', mode: 'redirect', edges: [{ name: 'e', host: '1.2.3.4', httpPort: 8081 }] });
  assert.ok(/proxy_pass/.test(proxy) && !/return 302/.test(proxy));
  assert.ok(/return 302/.test(redirect) && !/proxy_pass/.test(redirect));
});

check('a rewrite with no edges is refused, not reported as success', () => {
  // Writing a proxy config that forwards to nothing and calling it done is
  // worse than not writing it: the machine looks configured and serves
  // nothing, which is the state this whole resync exists to prevent.
  const resyncSrc = readFileSync(new URL('../src/services/gatewayResync.js', import.meta.url), 'utf8');
  assert.ok(/if \(!edges\.length\)/.test(resyncSrc), 'an empty edge list is written anyway');
  assert.ok(/no-edge-addresses/.test(resyncSrc));
  assert.ok(/addressless/.test(resyncSrc), 'it does not name the machines it could not resolve');
});

check('it needs no credentials, because the helper is already there', () => {
  // The privileged helper installed nginx on that machine and issued its
  // certificate. Rewriting a file it owns is less than it has done, and
  // storing an SSH password to do it would be a new secret for no new
  // capability.
  const resyncSrc = readFileSync(new URL('../src/services/gatewayResync.js', import.meta.url), 'utf8');
  assert.ok(/runTask\(server, 'POST \/host\/apply'/.test(resyncSrc), 'it does not go through the helper');
  assert.ok(!/ssh|password|privateKey/i.test(resyncSrc), 'it reaches for credentials');
});

check('only a machine already prepared is touched', () => {
  // Adding an edge must not quietly turn an untouched machine into a gateway.
  const resyncSrc = readFileSync(new URL('../src/services/gatewayResync.js', import.meta.url), 'utf8');
  assert.ok(/state !== 'applied'/.test(resyncSrc), 'an unprepared machine would be configured');
  assert.ok(/helper\?\.seen/.test(resyncSrc), 'a machine without the helper is attempted anyway');
});

check('it writes the configuration and nothing else', () => {
  // Taken from the same plan that prepares a machine rather than composed
  // separately, so a resync writes what a preparation would write — one
  // description of what an edge-proxy's nginx looks like. And no apt, no
  // certbot: this is a file and a reload.
  const { resyncSteps } = resyncModule;
  const ids = resyncSteps(plan({ mode: 'proxy', edges: [{ name: 'e', host: '1.2.3.4', httpPort: 8081 }] }))
    .map(s2 => s2.id);
  assert.deepEqual(ids, ['write-conf', 'enable-site', 'test-conf', 'reload']);
});

check('a machine that cannot be reached does not fail the save', () => {
  // The network is the operator's edit. A machine being unreachable is a fact
  // to report, not a reason to refuse it.
  const resyncSrc = readFileSync(new URL('../src/services/gatewayResync.js', import.meta.url), 'utf8');
  assert.ok(/catch \(e\) \{[\s\S]{0,200}return \{ ok: false/.test(resyncSrc),
    'an unreachable machine throws out of the save');
});

console.log('\nEACH MACHINE GETS ITS OWN ADDRESS SELECTOR:');

check('the selector sits beside its own link, not above the previous one', () => {
  // Rendered above the label it belonged to, one selector read as though it
  // belonged to the edge before it — a control next to the wrong name is worse
  // than no control.
  const panel = readFileSync(new URL('../../frontend/src/components/ChannelsPanel.jsx', import.meta.url), 'utf8');
  assert.ok(/addresses = null/.test(panel), 'Copyable cannot carry a selector');
  assert.ok(/addresses=\{x\.urls\?\.length > 1/.test(panel), 'the selector is not per machine');
  assert.ok(/pickedHost\[x\.edge\]/.test(panel), 'the choice is shared between machines');
});

console.log(failures ? `\n${failures} gateway-plan check(s) failed` : '\nall gateway-plan checks passed');
process.exit(failures ? 1 : 0);
