// iter11 m1 — agent enrollment.
//
// Two of the routes this covers are unauthenticated by necessity: the machine
// running the installer has no panel account. The ticket is therefore the
// entire authority, and these checks exist to prove it is a narrow one.
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { hashTicket, newTicket } from '../src/models/AgentEnrollment.js';
import { installScript } from '../src/services/agentInstaller.js';
import { isPrivateAddress } from '../src/routes/agentEnroll.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

console.log('TICKETS:');

check('a ticket is 32 random bytes, not a guessable id', () => {
  const a = newTicket(), b = newTicket();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

check('only the hash is ever stored', () => {
  const raw = newTicket();
  const h = hashTicket(raw);
  assert.notEqual(h, raw);
  assert.equal(h.length, 64);
  assert.equal(hashTicket(raw), h, 'hashing must be stable or a valid ticket would stop matching');
});

check('a different ticket does not collide', () => {
  assert.notEqual(hashTicket(newTicket()), hashTicket(newTicket()));
});

console.log('\nADDRESS CLASSIFICATION (used to warn, never to block):');

check('RFC1918 ranges are recognised', () => {
  for (const h of ['10.0.0.5', '192.168.1.7', '172.16.0.1', '172.31.255.254', '127.0.0.1', 'localhost'])
    assert.equal(isPrivateAddress(h), true, h);
});

check('172.32 is public — the /12 boundary is not the whole second octet', () => {
  assert.equal(isPrivateAddress('172.32.0.1'), false);
  assert.equal(isPrivateAddress('172.15.0.1'), false);
});

check('routable addresses and hostnames are not flagged', () => {
  for (const h of ['185.1.2.3', 'edge1.bbesport.com', '8.8.8.8'])
    assert.equal(isPrivateAddress(h), false, h);
});

check('IPv6 loopback and ULA are recognised', () => {
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('[fd00::1]'), true);
  assert.equal(isPrivateAddress('2001:db8::1'), false);
});

console.log('\nINSTALLER:');

const script = installScript({
  panelUrl: 'https://panel.example', ticket: 'a'.repeat(64),
  baseUrl: 'http://10.0.0.5:8090', logDir: '/var/log/nimble',
});
writeFileSync('/tmp/nnm-install-test.sh', script);

check('it is valid POSIX sh', () => {
  execFileSync('sh', ['-n', '/tmp/nnm-install-test.sh']);
});

check('it carries no panel credential — only the one-time ticket', () => {
  // Anything that looks like a stored secret would mean the panel handed a
  // long-lived credential to a machine it has not yet verified.
  assert.ok(!/JWT_SECRET|SETUP_TOKEN|ZABBIX_TOKEN|apiKey|clientId/i.test(script));
  assert.ok(script.includes('a'.repeat(64)), 'the ticket must be present');
});

check('the agent token is generated on the server, not sent to it', () => {
  assert.ok(/openssl rand -hex 24|randomBytes\(24\)/.test(script), 'must generate locally');
  // The only direction a token travels is server -> panel, in the enrol call.
  assert.ok(script.includes('/api/agents/enroll'));
});

check('the token never appears in argv, where any user could read it', () => {
  // It is passed through the environment; argv is world-readable via /proc.
  assert.ok(script.includes('TOKEN="$TOKEN" node -e'));
  assert.ok(!/node -e .*\$TOKEN"?\s*$/m.test(script));
});

check('it refuses to run without root, curl or a modern node', () => {
  assert.ok(script.includes('[ "$(id -u)" = "0" ]'));
  assert.ok(script.includes('command -v curl'));
  assert.ok(script.includes('NODE_MAJOR'));
});

check('it does not touch Nimble in any way', () => {
  assert.ok(!/nimble\.conf|systemctl (restart|reload) nimble|service nimble/.test(script),
    'installing an agent must never restart a broadcast server');
});

check('an existing token is preserved unless explicitly forced', () => {
  assert.ok(script.includes('NNM_FORCE'));
  assert.ok(script.includes('keeping the current token'));
});

check('the unit confines the agent, including read-only logs', () => {
  assert.ok(script.includes('ProtectSystem=strict'));
  assert.ok(script.includes('NoNewPrivileges=yes'));
  assert.ok(script.includes('ReadOnlyPaths=$LOG_DIR'));
  assert.ok(script.includes('ReadWritePaths=$CONF_DIR $MEDIA_DIR'));
});

check('the env file is written with a restrictive mode', () => {
  assert.ok(script.includes('umask 077'));
  assert.ok(script.includes('chmod 600 "$ENV_FILE"'));
});

check('it verifies the agent locally before reporting success', () => {
  const enrollAt = script.indexOf('/api/agents/enroll');
  const healthAt = script.indexOf('127.0.0.1:$PORT/health');
  assert.ok(healthAt > 0 && healthAt < enrollAt, 'health check must precede enrollment');
});

check('shell metacharacters in operator input cannot break out', () => {
  const nasty = installScript({
    panelUrl: "https://x'; rm -rf /; echo '", ticket: 'b'.repeat(64),
    baseUrl: "http://y'&&curl evil'", logDir: "/var/log/n'ble",
  });
  writeFileSync('/tmp/nnm-install-nasty.sh', nasty);
  execFileSync('sh', ['-n', '/tmp/nnm-install-nasty.sh']);
  // Every interpolation sits inside single quotes with ' escaped as '\'' —
  // so a quote in the input closes and reopens the literal rather than
  // ending it.
  assert.ok(nasty.includes(`'\\''`), 'quotes must be escaped, not stripped');
});

const acheck = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); fail++; }
};

// The api image is built with the backend directory as its context, so
// anything the panel serves has to live under backend/src. Reaching up to
// agent/ compiled fine and broke every build command that existed.
console.log('\nPACKAGING:');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDORED = path.join(HERE, '..', 'src', 'assets', 'nnm-agent.mjs');
const ORIGINAL = path.join(HERE, '..', '..', 'agent', 'nnm-agent.mjs');

check('the agent the panel serves lives inside backend/src', () => {
  const src = readFileSync(path.join(HERE, '..', 'src', 'routes', 'agentEnroll.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('const AGENT_SRC'));
  assert.ok(line, 'AGENT_SRC not found');
  assert.ok(!line.includes('../../../'), 'must not reach outside the Docker build context');
  assert.ok(readFileSync(VENDORED, 'utf8').startsWith('#!'), 'vendored copy missing or not the agent');
});

check('the vendored copy has not drifted from agent/nnm-agent.mjs', () => {
  assert.equal(readFileSync(VENDORED, 'utf8'), readFileSync(ORIGINAL, 'utf8'),
    'run: cp agent/nnm-agent.mjs backend/src/assets/nnm-agent.mjs');
});

// Mounting this router at /api must not put anything in front of the routers
// mounted after it. A sub-router with use(requireAuth) did exactly that.
console.log('\nMOUNT ISOLATION:');

await acheck('routers mounted after this one still receive their requests', async () => {
  const { agentEnrollRouter } = await import('../src/routes/agentEnroll.js');
  const app = express();
  app.use(express.json());
  app.use('/api', agentEnrollRouter);
  app.use('/api/servers', (req, res) => res.json({ reached: 'later' }));
  app.use('/api/audit', (req, res) => res.json({ reached: 'later' }));
  const srv = app.listen(0);
  const port = srv.address().port;
  try {
    for (const p of ['/api/servers/S1/agent', '/api/audit']) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(r.status, 200, `${p} was intercepted with ${r.status}`);
      assert.equal((await r.json()).reached, 'later');
    }
  } finally { srv.close(); }
});

console.log(fail ? `\n${fail} failed, ${pass} passed` : '\nall agent-enrollment checks passed');
process.exit(fail ? 1 : 0);
