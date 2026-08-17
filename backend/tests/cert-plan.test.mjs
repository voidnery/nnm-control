// Three ways to get a certificate, and the one that has no safety net.
//
// `acme-http` is proven code — the gateway plan has been running it. The other
// two are new, and the one that needs the most care is `upload`, because it is
// the only one where a human supplies the bytes and nothing downstream checks
// them until a player refuses to connect.
//
// So most of this file is about reading an uploaded certificate: a key that
// belongs to something else, a name that is not covered, a wildcard that
// covers less than it looks like it does, an expiry that has passed, a chain
// with its intermediate missing. Each one has been somebody's outage.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  METHODS, DNS_PROVIDERS, missingInputs, inspectUploaded, coversDomain,
  buildSteps, certPath, keyPath, PATHS_TOUCHED, BINARIES_USED,
} from '../src/services/certPlan.js';
import { ALLOWED_PATHS, ALLOWED_BINARIES } from '../src/services/privilegedHelper.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(here, 'fixtures', 'certs', n), 'utf8');
const leaf = fixture('leaf.pem');
const leafKey = fixture('leaf.key');
const bundle = fixture('bundle.pem');
const otherKey = fixture('other.key');
const selfSigned = fixture('ss.pem');
const selfSignedKey = fixture('ss.key');
const short = fixture('short.pem');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

console.log('Certificate methods\n');

// --- the choice itself ------------------------------------------------------

check('all three methods are offered, with their costs stated', () => {
  assert.deepEqual(Object.keys(METHODS).sort(), ['acme-dns', 'acme-http', 'upload']);
  for (const [id, m] of Object.entries(METHODS)) {
    assert.ok(m.cost && m.cost.length > 20, `${id} does not say what it costs`);
    assert.equal(typeof m.automaticRenewal, 'boolean');
  }
});

check('only the DNS method can issue a wildcard, and only upload does not renew itself', () => {
  assert.equal(METHODS['acme-dns'].wildcard, true);
  assert.equal(METHODS['acme-http'].wildcard, false);
  assert.equal(METHODS['acme-http'].automaticRenewal, true);
  assert.equal(METHODS['acme-dns'].automaticRenewal, true);
  assert.equal(METHODS.upload.automaticRenewal, false);
});

check('a plan that renews itself says so, and one that does not says that louder', () => {
  const auto = buildSteps({ method: 'acme-http', domain: 'edge.example.ru' });
  const manual = buildSteps({ method: 'upload', domain: 'edge.example.ru',
                              certificatePem: leaf, privateKeyPem: leafKey });
  assert.match(auto.renewalNote, /renews this on its own/);
  assert.match(manual.renewalNote, /Nothing renews this/);
});

// --- what each method still needs -------------------------------------------

check('missing inputs are all named at once, not one per attempt', () => {
  assert.deepEqual(missingInputs('acme-dns', {}).sort(), ['dns-provider', 'domain']);
  assert.deepEqual(missingInputs('upload', { domain: 'e.ru' }).sort(),
    ['certificate', 'private-key']);
});

check('a DNS provider nobody wired up is refused by name', () => {
  assert.deepEqual(missingInputs('acme-dns', { domain: 'e.ru', dnsProvider: 'namecheap' }),
    ['unsupported-dns-provider']);
});

check('a provider that needs no token is not asked for one', () => {
  // route53 takes its credentials from the instance role, so demanding a token
  // would block a setup that works.
  assert.equal(DNS_PROVIDERS.route53.credentialsArg, null);
  assert.deepEqual(missingInputs('acme-dns', { domain: 'e.ru', dnsProvider: 'route53' }), []);
  assert.deepEqual(missingInputs('acme-dns', { domain: 'e.ru', dnsProvider: 'cloudflare' }),
    ['dns-api-token']);
});

check('an unknown method does not quietly produce an empty plan', () => {
  assert.deepEqual(missingInputs('acme-carrier-pigeon', { domain: 'e.ru' }), ['unknown-method']);
  assert.equal(buildSteps({ method: 'acme-carrier-pigeon', domain: 'e.ru' }).ok, false);
});

// --- reading an uploaded certificate ----------------------------------------

check('a good certificate and its key pass, and say what they cover', () => {
  const r = inspectUploaded({ certificatePem: bundle, privateKeyPem: leafKey,
                              domain: 'edge.example.ru' });
  assert.deepEqual(r.problems, [], JSON.stringify(r));
  assert.ok(r.ok);
  assert.deepEqual(r.names, ['edge.example.ru', '*.wild.example.ru']);
  assert.ok(r.daysLeft > 80 && r.daysLeft <= 90, `daysLeft was ${r.daysLeft}`);
});

check('a key belonging to a different certificate is caught', () => {
  const r = inspectUploaded({ certificatePem: bundle, privateKeyPem: otherKey,
                              domain: 'edge.example.ru' });
  assert.ok(r.problems.includes('key-does-not-match-certificate'),
    'a mismatched key was accepted — nginx would start and every handshake would fail');
});

check('a certificate for a different name is caught', () => {
  const r = inspectUploaded({ certificatePem: bundle, privateKeyPem: leafKey,
                              domain: 'other-edge.example.ru' });
  assert.ok(r.problems.includes('certificate-does-not-cover-domain'));
});

check('a self-signed certificate is a problem, not a note', () => {
  // Every player refuses one. Recording it as a warning would let it through.
  const r = inspectUploaded({ certificatePem: selfSigned, privateKeyPem: selfSignedKey,
                              domain: 'edge.example.ru' });
  assert.ok(r.problems.includes('self-signed'));
  assert.equal(r.ok, false);
});

check('a leaf with no intermediate is noted, because it fails on some clients only', () => {
  const r = inspectUploaded({ certificatePem: leaf, privateKeyPem: leafKey,
                              domain: 'edge.example.ru' });
  assert.ok(r.notes.includes('no-intermediate-bundled'),
    'a bare leaf passed silently — the failure it causes is intermittent by client');
  // Still usable: it is a note rather than a problem, and the bundle version
  // must not carry the same note.
  assert.ok(r.ok);
  assert.ok(!inspectUploaded({ certificatePem: bundle, privateKeyPem: leafKey,
                               domain: 'edge.example.ru' }).notes.includes('no-intermediate-bundled'));
});

check('expiry is read against a clock that can be moved, and both ends are checked', () => {
  const past = inspectUploaded({ certificatePem: short, privateKeyPem: leafKey,
                                 domain: 'edge.example.ru', now: new Date('2030-01-01') });
  assert.ok(past.problems.includes('expired'));
  const future = inspectUploaded({ certificatePem: short, privateKeyPem: leafKey,
                                   domain: 'edge.example.ru', now: new Date('2000-01-01') });
  assert.ok(future.problems.includes('not-yet-valid'),
    'a certificate that has not started yet was accepted');
});

check('an expiry inside a month is flagged before it becomes an outage', () => {
  const r = inspectUploaded({ certificatePem: short, privateKeyPem: leafKey,
                              domain: 'edge.example.ru' });
  assert.ok(r.notes.includes('expires-soon'));
});

check('rubbish in either field is refused rather than half-read', () => {
  const r = inspectUploaded({ certificatePem: 'not a certificate', privateKeyPem: leafKey,
                              domain: 'e.ru' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['certificate-unreadable']);
  const k = inspectUploaded({ certificatePem: bundle, privateKeyPem: 'not a key',
                              domain: 'edge.example.ru' });
  assert.ok(k.problems.includes('key-unreadable'));
});

check('passing does not mean a player will accept it, and the result says so', () => {
  const r = inspectUploaded({ certificatePem: bundle, privateKeyPem: leafKey,
                              domain: 'edge.example.ru' });
  assert.equal(r.trustUnknown, true,
    'an offline check that passes must not read as approval — the handshake decides');
});

// --- wildcards, which cover less than they look like they do -----------------

check('a wildcard covers one label and not two, and not the bare domain', () => {
  const names = ['*.wild.example.ru'];
  assert.equal(coversDomain(names, 'a.wild.example.ru'), true);
  assert.equal(coversDomain(names, 'a.b.wild.example.ru'), false,
    'a wildcard was treated as covering two labels');
  assert.equal(coversDomain(names, 'wild.example.ru'), false,
    'a wildcard was treated as covering the bare domain');
});

check('name matching ignores case, as DNS does', () => {
  assert.equal(coversDomain(['Edge.Example.RU'], 'edge.example.ru'), true);
});

// --- the steps --------------------------------------------------------------

check('every method lands the certificate in the same place', () => {
  const a = buildSteps({ method: 'acme-http', domain: 'e.ru' });
  const b = buildSteps({ method: 'acme-dns', domain: 'e.ru', dnsProvider: 'cloudflare', dnsToken: 't' });
  const c = buildSteps({ method: 'upload', domain: 'e.ru', certificatePem: leaf, privateKeyPem: leafKey });
  for (const p of [a, b, c]) {
    assert.equal(p.certPath, certPath('e.ru'));
    assert.equal(p.keyPath, keyPath('e.ru'));
  }
});

check('the DNS token goes into a file at 0600 and never onto a command line', () => {
  const p = buildSteps({ method: 'acme-dns', domain: 'e.ru',
                         dnsProvider: 'cloudflare', dnsToken: 'sekrit-token' });
  const file = p.steps.find(s => s.id === 'write-dns-credentials');
  assert.ok(file, 'no credentials file step');
  assert.equal(file.mode, '0600');
  assert.equal(file.secret, true);
  for (const s of p.steps) {
    if (s.command) assert.ok(!s.command.join(' ').includes('sekrit-token'),
      `${s.id} puts the token on the command line, where the process list and the audit record can see it`);
  }
});

check('the private key is written 0600 and marked secret; the certificate is not', () => {
  const p = buildSteps({ method: 'upload', domain: 'e.ru',
                         certificatePem: leaf, privateKeyPem: leafKey });
  const k = p.steps.find(s => s.id === 'write-key');
  const c = p.steps.find(s => s.id === 'write-certificate');
  assert.equal(k.mode, '0600');
  assert.equal(k.secret, true);
  assert.equal(c.mode, '0644');
  assert.notEqual(c.secret, true, 'a public certificate marked secret hides it from the audit for nothing');
});

check('an edge answers the HTTP challenge itself; a gateway uses the web server it has', () => {
  // `--webroot` on a machine with no web server is the quiet failure: certbot
  // writes a file into a directory nobody serves and the challenge times out.
  const edge = buildSteps({ method: 'acme-http', domain: 'e.ru', role: 'edge' });
  const gw = buildSteps({ method: 'acme-http', domain: 'e.ru', role: 'gateway' });
  const cmd = (p) => p.steps.find(s => s.id === 'issue-certificate').command.join(' ');
  assert.match(cmd(edge), /--standalone/);
  assert.ok(!cmd(edge).includes('--webroot'), 'an edge was told to use a webroot nothing serves');
  assert.match(cmd(gw), /--webroot -w \/var\/www\/html/);
  assert.ok(!cmd(gw).includes('--standalone'),
    'a gateway would bind port 80 while nginx already holds it');
});

check('the edge role never needs the webroot the edge profile forbids', () => {
  assert.ok(!PATHS_TOUCHED.edge.includes('/var/www/html'));
});

check('the DNS method needs no inbound port and the HTTP one says it needs 80', () => {
  const http = buildSteps({ method: 'acme-http', domain: 'e.ru' });
  const dns = buildSteps({ method: 'acme-dns', domain: 'e.ru', dnsProvider: 'cloudflare', dnsToken: 't' });
  assert.equal(http.steps.find(s => s.id === 'issue-certificate').needsPort, 80);
  assert.equal(dns.steps.find(s => s.id === 'issue-certificate').needsPort, null,
    'the whole point of the DNS method is that nothing inbound is required');
});

check('upload contacts nothing: no packages, no commands, two files', () => {
  const p = buildSteps({ method: 'upload', domain: 'e.ru',
                         certificatePem: leaf, privateKeyPem: leafKey });
  assert.deepEqual(p.steps.map(s => s.kind), ['file', 'file']);
});

check('issuing a certificate is never undone', () => {
  // Rate-limited and slow to replace. Deleting one on rollback turns a failed
  // step into a wait.
  for (const m of [{ method: 'acme-http', domain: 'e.ru' },
                   { method: 'acme-dns', domain: 'e.ru', dnsProvider: 'cloudflare', dnsToken: 't' }]) {
    const p = buildSteps(m);
    assert.equal(p.steps.find(s => s.id === 'issue-certificate').undo, null);
  }
});

// --- the helper has to actually be allowed to do this -----------------------

check('every path these plans write is one the privileged helper permits', () => {
  const covered = (p) => ALLOWED_PATHS.some(root => p === root || p.startsWith(`${root}/`));
  for (const p of PATHS_TOUCHED.gateway) {
    assert.ok(covered(p), `${p} is not in the helper's gateway paths — the step would be refused`);
  }
  for (const m of [{ method: 'acme-http', domain: 'e.ru' },
                   { method: 'acme-dns', domain: 'e.ru', dnsProvider: 'cloudflare', dnsToken: 't' },
                   { method: 'upload', domain: 'e.ru', certificatePem: leaf, privateKeyPem: leafKey }]) {
    for (const s of buildSteps(m).steps) {
      if (s.path) assert.ok(covered(s.path), `${s.id} writes ${s.path}, which the helper refuses`);
    }
  }
});

check('every binary these plans run is one the privileged helper permits', () => {
  for (const b of BINARIES_USED) {
    assert.ok(ALLOWED_BINARIES.includes(b), `${b} is not in ALLOWED_BINARIES`);
  }
  for (const m of [{ method: 'acme-http', domain: 'e.ru' },
                   { method: 'acme-dns', domain: 'e.ru', dnsProvider: 'cloudflare', dnsToken: 't' }]) {
    for (const s of buildSteps(m).steps) {
      if (s.command) assert.ok(ALLOWED_BINARIES.includes(s.command[0]),
        `${s.id} runs ${s.command[0]}, which the helper refuses`);
    }
  }
});

console.log(failures ? `\n${failures} certificate check(s) failed` : '\nall certificate checks passed');
process.exit(failures ? 1 : 0);
