// The edge helper, and writing nimble.conf.
//
// Two things are being trusted here that were not before. A machine whose job
// is serving video can now be given a root service, and something can rewrite
// the file that binds it to WMSPanel. Both deserve checks that fail loudly.
//
// The first half is about the profile being *smaller* on an edge, in the panel
// and in the agent's own copy, and about neither being able to grow by
// accident. The second is about leaving every byte of somebody's nimble.conf
// alone except the five keys this feature owns.

import assert from 'node:assert/strict';
import {
  PROFILES, PROFILE_IDS, profileFor, stepAllowed, privilegedEligibility,
  privilegedInstaller, ALLOWED_PATHS, ALLOWED_BINARIES,
} from '../src/services/privilegedHelper.js';
import {
  CONF_PATH, DEFAULT_SSL_PORT, MANAGED_KEYS, SECRET_KEYS,
  parseConf, maskConf, upsert, describeChange, blockers, buildPlan, verdict,
} from '../src/services/llhlsPlan.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(join(here, '..', 'src', 'assets', 'nnm-agent.mjs'), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('Edge helper and LL-HLS transport\n');

// --- the profile ------------------------------------------------------------

check('the edge profile is strictly smaller than the gateway one, apart from /etc/nimble', () => {
  const g = PROFILES.gateway, e = PROFILES.edge;
  const extraPaths = e.paths.filter(p => !g.paths.includes(p));
  assert.deepEqual(extraPaths, ['/etc/nimble'],
    `the edge profile gained something beyond /etc/nimble: ${extraPaths.join(', ')}`);
  const extraBins = e.binaries.filter(b => !g.binaries.includes(b));
  assert.deepEqual(extraBins, [], `the edge profile can run something a gateway cannot: ${extraBins}`);
});

check('an edge gets no nginx, no webroot and no kill', () => {
  for (const p of ['/etc/nginx', '/var/www/html']) {
    assert.ok(!PROFILES.edge.paths.includes(p), `${p} is in the edge profile and nothing there needs it`);
  }
  for (const b of ['nginx', 'kill']) {
    assert.ok(!PROFILES.edge.binaries.includes(b),
      `${b} is in the edge profile — on a media server a process on port 80 belongs to somebody`);
  }
});

check('/etc/nimble is reachable on an edge and not on a gateway', () => {
  const step = { kind: 'file', path: '/etc/nimble/nimble.conf' };
  assert.equal(stepAllowed(step, 'edge'), true);
  assert.equal(stepAllowed(step, 'gateway'), false,
    'a gateway can write a Nimble configuration it has no reason to have');
});

check('nginx is reachable on a gateway and not on an edge', () => {
  const step = { kind: 'command', command: ['nginx', '-t'] };
  assert.equal(stepAllowed(step, 'gateway'), true);
  assert.equal(stepAllowed(step, 'edge'), false);
});

check('an unknown profile falls to the gateway lists in the panel and to edge in the agent', () => {
  // The panel's default is gateway because every caller before this change was
  // a gateway and a silent widening would be the worse mistake there. The
  // agent's default is edge because a helper that cannot read its own
  // environment should end up with less, not more.
  assert.equal(stepAllowed({ kind: 'command', command: ['nginx'] }, 'nonsense'), true);
  assert.match(agentSource,
    /PROFILES\[process\.env\.NNM_PRIVILEGED_PROFILE\] \? process\.env\.NNM_PRIVILEGED_PROFILE : 'edge'/,
    'the agent does not fall back to the smaller profile');
});

check('the old exported names still mean the gateway lists', () => {
  assert.deepEqual(ALLOWED_PATHS, PROFILES.gateway.paths);
  assert.deepEqual(ALLOWED_BINARIES, PROFILES.gateway.binaries);
});

check('the agent carries the same two profiles as the panel, path for path', () => {
  // The lists exist twice on purpose — the panel composes the plan and the
  // panel is what might be compromised — so they have to be held equal.
  for (const id of PROFILE_IDS) {
    for (const p of PROFILES[id].paths) {
      assert.ok(agentSource.includes(`'${p}'`), `${p} is in the panel's ${id} profile and not in the agent`);
    }
    for (const b of PROFILES[id].binaries) {
      assert.ok(agentSource.includes(`'${b}'`), `${b} is in the panel's ${id} profile and not in the agent`);
    }
  }
  // And the reverse for the one that matters: the agent's edge list must not
  // quietly contain nginx.
  const edgeBlock = agentSource.slice(agentSource.indexOf('edge: {'), agentSource.indexOf('};', agentSource.indexOf('edge: {')));
  assert.ok(!edgeBlock.includes("'nginx'"), "the agent's edge profile can run nginx");
  assert.ok(!edgeBlock.includes("'kill'"), "the agent's edge profile can kill");
});

check('purpose decides the profile, and a delivery media server is an edge', () => {
  assert.equal(profileFor('gateway'), 'gateway');
  assert.equal(profileFor('nimble-cdn'), 'edge');
  // A purpose that needs no helper still answers, and answers with the smaller
  // profile — the question "which profile" must never resolve upwards.
  assert.equal(profileFor('nimble'), 'edge');
  assert.equal(profileFor(undefined), 'edge');
});

check('a delivery media server may be offered the helper, and still needs an agent first', () => {
  // Narrowed in v1.17.0 from "any non-gateway" to "whatever needs it". A
  // `nimble` machine processes video and serves nobody, so it has nothing the
  // helper would do.
  const withAgent = { purpose: 'nimble-cdn', agent: { enabled: true } };
  assert.deepEqual(privilegedEligibility(withAgent), { ok: true, profile: 'edge', purpose: 'nimble-cdn' });
  assert.equal(privilegedEligibility({ purpose: 'nimble-cdn' }).code, 'no-agent');
  assert.equal(privilegedEligibility({ purpose: 'nimble', agent: { enabled: true } }).code,
    'helper-not-applicable');
});

check('the installer writes the profile into the unit environment, not into a request', () => {
  const edge = privilegedInstaller({ panelUrl: 'http://panel', token: 't', profile: 'edge' });
  assert.match(edge, /NNM_PRIVILEGED_PROFILE='edge'/);
  assert.match(edge, /Profile: edge/);
  assert.ok(!edge.includes('/etc/nginx'), 'the edge installer creates an nginx directory');
  assert.ok(edge.includes('/etc/nimble'), 'the edge installer does not create /etc/nimble');
  const gw = privilegedInstaller({ panelUrl: 'http://panel', token: 't', profile: 'gateway' });
  assert.match(gw, /NNM_PRIVILEGED_PROFILE='gateway'/);
  assert.ok(gw.includes('/etc/nginx'));
  assert.ok(!gw.includes('/etc/nimble'));
});

check('the installer defaults to gateway, so no existing caller was widened', () => {
  const d = privilegedInstaller({ panelUrl: 'http://panel', token: 't' });
  assert.match(d, /NNM_PRIVILEGED_PROFILE='gateway'/);
});

// --- reading somebody else's nimble.conf ------------------------------------

const CONF = `#
# Nimble Streamer configuration
#
port = 8081
client_id = abcdefghijklmnop
api_key = 0123456789abcdef0123456789abcdef
# ssl_http2_enabled = true
management_port = 8082
cache_dir = /var/cache/nimble
`;

check('a commented-out setting is not a setting', () => {
  const { settings } = parseConf(CONF);
  assert.equal(settings.has('ssl_http2_enabled'), false,
    'a commented line was read as configuration — the plan would change nothing and report success');
  assert.equal(settings.get('port').value, '8081');
});

check('credentials are masked, and masking keeps the file readable', () => {
  const masked = maskConf(CONF);
  assert.ok(!masked.includes('abcdefghijklmnop'), 'the WMSPanel client id survived masking');
  assert.ok(!masked.includes('0123456789abcdef0123456789abcdef'), 'the API key survived masking');
  assert.match(masked, /client_id = <16 characters, hidden>/);
  assert.match(masked, /port = 8081/, 'masking removed something it should not have');
  assert.deepEqual(SECRET_KEYS.includes('api_key'), true);
});

// --- writing it -------------------------------------------------------------

check('new keys are appended in one labelled block, and nothing else moves', () => {
  const r = upsert(CONF, { ssl_port: '8443', ssl_http2_enabled: 'true' });
  assert.equal(r.changed.length, 0);
  assert.deepEqual(r.added.map(a => a.key), ['ssl_port', 'ssl_http2_enabled']);
  // Every original line survives, in order.
  const before = CONF.split('\n');
  const after = r.text.split('\n');
  assert.deepEqual(after.slice(0, before.length - 1), before.slice(0, before.length - 1),
    'the existing file was reordered or rewritten');
  assert.match(r.text, /# --- NNM Control: Low-Latency HLS transport/);
});

check('an existing key is changed in place rather than appended twice', () => {
  const withPort = CONF + 'ssl_port = 9999\n';
  const r = upsert(withPort, { ssl_port: '8443' });
  assert.deepEqual(r.changed, [{ key: 'ssl_port', from: '9999', to: '8443' }]);
  assert.equal(r.added.length, 0);
  assert.equal((r.text.match(/^ssl_port/gm) || []).length, 1,
    'the file now sets ssl_port twice and Nimble reads one of them');
});

check('a key already at the wanted value is left alone', () => {
  const r = upsert(CONF + 'ssl_port = 8443\n', { ssl_port: '8443' });
  assert.equal(r.unchanged, true);
  assert.deepEqual(r.changed, []);
});

check('a file with no trailing newline does not get two settings joined into one', () => {
  const r = upsert('port = 8081', { ssl_port: '8443' });
  assert.ok(!/port = 8081ssl_port/.test(r.text) && !/8081\s*ssl_port = 8443/.test(r.text.split('\n')[0]),
    'the appended block ran onto the last line');
  const { settings } = parseConf(r.text);
  assert.equal(settings.get('port').value, '8081');
  assert.equal(settings.get('ssl_port').value, '8443');
});

check('the diff shown to an operator is masked too', () => {
  const r = upsert(CONF, { ssl_port: '8443' });
  const d = describeChange(CONF, r.text);
  const text = JSON.stringify(d);
  assert.ok(!text.includes('abcdefghijklmnop'), 'the diff leaks the client id');
  assert.ok(d.some(x => String(x.to).includes('ssl_port = 8443')));
});

// --- refusing to proceed ----------------------------------------------------

check('no certificate, no plan', () => {
  assert.ok(blockers({ conf: CONF, certPath: '', keyPath: '' }).includes('no-certificate'));
});

check('an ssl_port equal to the http port is caught here, not at restart', () => {
  assert.ok(blockers({ conf: CONF, certPath: '/c', keyPath: '/k', sslPort: 8081 })
    .includes('ssl-port-collides-with-http-port'));
  assert.ok(!blockers({ conf: CONF, certPath: '/c', keyPath: '/k', sslPort: 8443 })
    .includes('ssl-port-collides-with-http-port'));
});

check('a machine already serving HTTPS-only is not touched', () => {
  const httpsOnly = CONF.replace('port = 8081', 'port = 0');
  assert.ok(blockers({ conf: httpsOnly, certPath: '/c', keyPath: '/k' }).includes('http-already-disabled'));
});

check('an ssl_server block stops the plan instead of being guessed at', () => {
  const withBlock = CONF + '\nssl_server {\n  server_name = edge.example.ru\n}\n';
  assert.ok(blockers({ conf: withBlock, certPath: '/c', keyPath: '/k' })
    .includes('ssl-server-block-present'),
    'a per-host certificate block was ignored and a global one written beside it');
});

check('every blocker is reported at once', () => {
  const b = blockers({ conf: CONF.replace('port = 8081', 'port = 0'), certPath: '', keyPath: '', sslPort: 'x' });
  assert.ok(b.length >= 3, `only ${b.length} blockers named: ${b.join(', ')}`);
});

// --- the plan ---------------------------------------------------------------

check('the plan writes the file and restarts, and says what that costs', () => {
  const p = buildPlan({ conf: CONF, certPath: '/etc/letsencrypt/live/e/fullchain.pem',
                        keyPath: '/etc/letsencrypt/live/e/privkey.pem' });
  assert.equal(p.ok, true, JSON.stringify(p.blockers));
  assert.deepEqual(p.steps.map(s => s.id), ['write-nimble-conf', 'restart-nimble']);
  assert.equal(p.steps[0].path, CONF_PATH);
  assert.equal(p.sslPort, DEFAULT_SSL_PORT);
  assert.match(p.interruption, /ends every playback session/);
});

check('the file step is backed up, and its content is not put in the record', () => {
  const p = buildPlan({ conf: CONF, certPath: '/c', keyPath: '/k' });
  assert.equal(p.steps[0].backup, true);
  assert.equal(p.steps[0].undo, 'restore');
  assert.equal(p.steps[0].secretContent, true,
    'the file with the WMSPanel credentials in it would be recorded verbatim');
});

check('undoing the restart is another restart, not nothing', () => {
  // Restoring the file alone leaves the running process on the new
  // configuration, which is the shape of every "applied and did nothing" this
  // project has collected.
  const p = buildPlan({ conf: CONF, certPath: '/c', keyPath: '/k' });
  assert.deepEqual(p.steps[1].undo, ['systemctl', 'restart', 'nimble']);
});

check('every managed key ends up in the file and nothing else does', () => {
  const p = buildPlan({ conf: CONF, certPath: '/c', keyPath: '/k' });
  const { settings } = parseConf(p.steps[0].content);
  for (const k of MANAGED_KEYS) assert.ok(settings.has(k), `${k} was not written`);
  const original = parseConf(CONF).settings;
  for (const [k, v] of original) {
    assert.equal(settings.get(k)?.value, v.value, `${k} was changed and this plan does not own it`);
  }
});

check('a plan with nothing to do produces no steps rather than a pointless restart', () => {
  const done = CONF + `
ssl_port = 8443
ssl_certificate = /c
ssl_certificate_key = /k
ssl_http2_enabled = true
ssl_protocols = TLSv1.2 TLSv1.3
`;
  const p = buildPlan({ conf: done, certPath: '/c', keyPath: '/k' });
  assert.equal(p.unchanged, true);
  assert.deepEqual(p.steps, [], 'a no-op plan would still have dropped every session');
});

check('every step the plan makes is one the edge profile permits', () => {
  const p = buildPlan({ conf: CONF, certPath: '/c', keyPath: '/k' });
  for (const s of p.steps) {
    assert.ok(stepAllowed(s, 'edge'), `${s.id} would be refused by the helper on an edge`);
  }
});

// --- did it work ------------------------------------------------------------

check('TLS without parts is called out as the silent fallback, by name', () => {
  const v = verdict({ tls: { tls: true, http2: true, certTrusted: true },
                      playlist: { lowLatency: { confirmed: false } } });
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ['parts']);
  assert.match(v.silentFallback, /the WMSPanel half is off/);
});

check('HTTP/2 missing is not reported as a working setup', () => {
  const v = verdict({ tls: { tls: true, http2: false, certTrusted: true },
                      playlist: { lowLatency: { confirmed: true } } });
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ['http2']);
  assert.equal(v.silentFallback, null, 'this is not the fallback case and must not be labelled one');
});

check('an untrusted certificate fails even though the handshake succeeded', () => {
  const v = verdict({ tls: { tls: true, http2: true, certTrusted: false },
                      playlist: { lowLatency: { confirmed: true } } });
  assert.ok(v.missing.includes('cert-trusted'),
    'we pass rejectUnauthorized:false and a player does not');
});

check('only both halves together are a pass', () => {
  assert.equal(verdict({ tls: { tls: true, http2: true, certTrusted: true },
                         playlist: { lowLatency: { confirmed: true } } }).ok, true);
  assert.equal(verdict({}).ok, false);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall edge/LL-HLS checks passed');
process.exit(failures ? 1 : 0);
