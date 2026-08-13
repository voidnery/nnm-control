// Turning a machine into a gateway, iter23 m2 — the plan.
//
// The panel is about to change a system. Everything it has written until now
// went into somebody else's API, where a wrong call is refused; apt-get is not
// refused. So this is the half that must be right before anything runs, and it
// has one rule above all: the plan shown is the plan applied.
import assert from 'node:assert/strict';
import { gatewayPlan, nginxConf, replacePlan } from '../src/services/gatewayPlan.js';

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

check('proxy mode without an edge is refused rather than pointed at nothing', () => {
  const p = plan({ mode: 'proxy', edges: [] });
  assert.ok(p.blocking.some(x => x.code === 'proxy-needs-an-edge'));
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
      assert.ok(['issue-cert', 'test-conf'].includes(s.id), `${s.id} changes something and cannot undo it`);
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

check('HTTP/2 is on, because LL-HLS silently falls back without it', () => {
  assert.match(nginxConf({ domain: 'x.example.com' }), /http2 on;/);
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
const applyRoute = routes.slice(routes.indexOf("'/servers/:id/gateway/apply'"), routes.indexOf("'/servers/:id/gateway/rollback'"));

check('the plan is recomputed at apply, not taken from the request', () => {
  // If the machine moved between the preview and the press, the operator
  // approved something else.
  assert.ok(/gatewayPlan\(\{ server, domain, mode, edges, ports/.test(applyRoute));
  assert.ok(/plan\.blocking\.length/.test(applyRoute), 'a blocked plan is applied anyway');
});

check('ports are re-read rather than remembered', () => {
  // Something can start listening between a plan and a press, and this is the
  // check whose staleness breaks somebody else's service.
  assert.ok(/'\/host\/ports'/.test(applyRoute));
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

console.log(failures ? `\n${failures} gateway-plan check(s) failed` : '\nall gateway-plan checks passed');
process.exit(failures ? 1 : 0);
