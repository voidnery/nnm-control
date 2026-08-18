// The certificate question, asked once.
//
// There were two of these. The gateway wizard knew one method — Let's Encrypt
// through the nginx it was about to start — and the LL-HLS screen knew three.
// Same question, two sets of answers, and which you got depended on which page
// you had opened.
//
// So these checks are about the two callers producing the *same* choices and
// differing only in where the result lands, and about the steps that exist
// only to answer an HTTP challenge not being run when there is no challenge.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gatewayPlan } from '../src/services/gatewayPlan.js';
import { METHODS, buildSteps as certSteps, certPath, keyPath } from '../src/services/certPlan.js';

const here = dirname(fileURLToPath(import.meta.url));
const front = (f) => readFileSync(join(here, '..', '..', 'frontend', 'src', f), 'utf8');
const shared = front('components/CertificateSetup.jsx');
const gwModal = front('components/GatewaySetupModal.jsx');
const llhlsPage = front('pages/LlhlsPage.jsx');

const leaf = readFileSync(join(here, 'fixtures', 'certs', 'bundle.pem'), 'utf8');
const key = readFileSync(join(here, 'fixtures', 'certs', 'leaf.key'), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('One certificate dialog\n');

const ports = { 80: { taken: false }, 443: { taken: false } };
const plan = (over = {}) => gatewayPlan({
  server: { name: 'gw' }, domain: 'cdn.example.com', mode: 'redirect', ports,
  email: 'ops@example.com', ...over,
});
const ids = (p) => p.steps.map(s => s.id);

// --- the same three, both sides ---------------------------------------------

check('the shared component offers exactly the methods the API accepts', () => {
  const m = shared.match(/export const CERT_METHODS = \[([^\]]*)\]/);
  assert.ok(m, 'the shared component has no method list');
  const offered = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort();
  assert.deepEqual(offered, Object.keys(METHODS).sort(),
    'the form offers a different set of methods than the server knows');
});

check('neither page keeps a method list of its own any more', () => {
  // Two lists is how the two dialogs came to disagree in the first place.
  for (const [name, src] of [['GatewaySetupModal', gwModal], ['LlhlsPage', llhlsPage]]) {
    assert.ok(!/const CERT_METHODS = \[/.test(src), `${name} still has its own method list`);
    assert.ok(/CertificateSetup/.test(src), `${name} does not use the shared component`);
  }
});

check('the destination is told, not asked', () => {
  // The operator answers what a machine is for, once, on the server card.
  // Where a certificate goes follows from that.
  assert.match(gwModal, /target="nginx"/);
  assert.match(llhlsPage, /target="nimble-conf"/);
  assert.ok(!/target=\{/.test(shared), 'the component lets a caller compute the destination');
});

// --- a gateway can now use all three ----------------------------------------

check('a gateway can be prepared with any of the three, and none is blocked', () => {
  for (const method of Object.keys(METHODS)) {
    const p = plan({ certMethod: method, dnsProvider: 'cloudflare', dnsToken: 't',
                     certificatePem: leaf, privateKeyPem: key });
    assert.deepEqual(p.blocking.map(b => b.code), [],
      `${method} is blocked on a gateway: ${p.blocking.map(b => b.code)}`);
  }
});

check('an unknown method is refused rather than silently treated as the old one', () => {
  const p = plan({ certMethod: 'acme-carrier-pigeon' });
  assert.ok(p.blocking.some(b => b.code === 'bad-cert-method'));
});

check('a method missing its own input is blocked by name', () => {
  const dns = plan({ certMethod: 'acme-dns', dnsProvider: 'cloudflare', dnsToken: '' });
  assert.ok(dns.blocking.some(b => b.code === 'cert-dns-api-token'), JSON.stringify(dns.blocking));
  const up = plan({ certMethod: 'upload', certificatePem: '', privateKeyPem: '' });
  assert.ok(up.blocking.some(b => b.code === 'cert-certificate'));
  assert.ok(up.blocking.some(b => b.code === 'cert-private-key'));
});

check('a missing domain is reported once, not twice under two names', () => {
  const p = plan({ domain: '' });
  const codes = p.blocking.map(b => b.code);
  assert.ok(codes.includes('bad-domain'));
  assert.ok(!codes.includes('cert-domain'),
    'the same problem was reported twice, sending the operator looking for a second one');
});

// --- the steps that only exist for a challenge ------------------------------

check('an HTTP challenge gets the temporary nginx site; the other two do not', () => {
  const http = ids(plan({ certMethod: 'acme-http' }));
  for (const id of ['write-acme-conf', 'enable-acme', 'reload-for-acme', 'drop-acme-conf']) {
    assert.ok(http.includes(id), `${id} missing from the HTTP-01 plan`);
  }
  const dns = ids(plan({ certMethod: 'acme-dns', dnsProvider: 'cloudflare', dnsToken: 't' }));
  const up = ids(plan({ certMethod: 'upload', certificatePem: leaf, privateKeyPem: key }));
  for (const id of ['write-acme-conf', 'enable-acme', 'reload-for-acme', 'drop-acme-conf']) {
    assert.ok(!dns.includes(id), `${id} runs for a DNS challenge, which answers nothing`);
    assert.ok(!up.includes(id), `${id} runs for an uploaded certificate, which proves nothing`);
  }
});

check('an uploaded certificate installs no ACME client', () => {
  const up = ids(plan({ certMethod: 'upload', certificatePem: leaf, privateKeyPem: key }));
  assert.ok(!up.includes('install-certbot'),
    'a package was added to a machine to do nothing');
  assert.ok(up.includes('write-certificate') && up.includes('write-key'));
});

check('a DNS challenge installs its plugin and writes the token to a file', () => {
  const p = plan({ certMethod: 'acme-dns', dnsProvider: 'cloudflare', dnsToken: 'sekrit' });
  assert.ok(ids(p).includes('install-dns-plugin'));
  const f = p.steps.find(s => s.id === 'write-dns-credentials');
  assert.equal(f.mode, '0600');
  assert.equal(f.secret, true);
  for (const s of p.steps) {
    if (s.command) assert.ok(!s.command.join(' ').includes('sekrit'),
      `${s.id} puts the token where the process list can read it`);
  }
});

// --- and the result lands in the same place whichever way it arrived --------

check('nginx is pointed at one path regardless of how the certificate got there', () => {
  const conf = plan({ certMethod: 'upload', certificatePem: leaf, privateKeyPem: key })
    .steps.find(s => s.id === 'write-conf');
  assert.match(conf.content, new RegExp(certPath('cdn.example.com').replace(/\//g, '\\/')),
    'the nginx configuration points somewhere the uploaded certificate was not written');
  assert.match(conf.content, new RegExp(keyPath('cdn.example.com').replace(/\//g, '\\/')));
});

check('an edge and a gateway differ in the challenge, not in the question', () => {
  // The only divergence certPlan admits: `--webroot` needs a web server, and a
  // media server has none.
  const edge = certSteps({ method: 'acme-http', domain: 'e.ru', role: 'edge' });
  const gw = certSteps({ method: 'acme-http', domain: 'e.ru', role: 'gateway' });
  const cmd = (p) => p.steps.find(s => s.id === 'issue-certificate').command.join(' ');
  assert.match(cmd(edge), /--standalone/);
  assert.match(cmd(gw), /--webroot/);
  assert.equal(edge.certPath, gw.certPath, 'the two roles disagree about where it lands');
});

// --- the ordering that makes the whole thing work ---------------------------

check('the certificate exists before the configuration that points at it', () => {
  for (const method of Object.keys(METHODS)) {
    const list = ids(plan({ certMethod: method, dnsProvider: 'cloudflare', dnsToken: 't',
                            certificatePem: leaf, privateKeyPem: key }));
    const cert = Math.max(list.indexOf('issue-certificate'), list.indexOf('write-certificate'));
    assert.ok(cert >= 0, `${method} produced no certificate step`);
    assert.ok(cert < list.indexOf('write-conf'),
      `${method} writes the nginx configuration before the certificate exists`);
    assert.ok(list.indexOf('write-conf') < list.indexOf('reload'),
      `${method} reloads before writing`);
  }
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall certificate dialog checks passed');
process.exit(failures ? 1 : 0);
