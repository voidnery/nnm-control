// Getting a certificate onto an edge, three ways.
//
// LL-HLS needs HTTP/2 over TLS or players fall back to ordinary HLS in
// silence, so a certificate on every edge is not optional. How it arrives is
// an operator's decision with real trade-offs, and the panel's job is to state
// them and then carry out whichever was chosen — not to pick one and hide the
// other two.
//
// The three:
//
//   acme-http   certbot proving the domain over port 80. This is what the
//               gateway plan already does, so it is proven code rather than a
//               new idea. Needs the name to resolve to this machine and port
//               80 reachable from outside.
//
//   acme-dns    certbot proving the domain by writing a DNS record. Needs an
//               API token for the DNS provider and nothing inbound at all,
//               which is what makes it work on a machine behind a filtered
//               port 80. It is also the only one of the three that can issue a
//               wildcard.
//
//   upload      the operator hands the panel a certificate and key, from
//               whatever authority they already use, and the panel places
//               them. No dependency on any ACME service, and no automatic
//               renewal — the panel counts the days instead.
//
// ---------------------------------------------------------------------------
// Why the third one exists, written down so nobody removes it as redundant.
//
// On 4 June 2026 Let's Encrypt published Subscriber Agreement 1.7, adding a
// term about United States sanctions. Reporting since is consistent on the
// substance: issuance continues for private companies and individuals in
// Russia, and stops for state institutions in fully sanctioned territories.
// ZeroSSL is reported to have restricted .ru around the same time, and
// Buypass closed its free service in August 2025.
//
// So for this operator — a commercial broadcaster — ACME against Let's Encrypt
// works today. "Works today" is exactly the kind of statement that has an
// expiry date, and an edge whose certificate cannot be renewed stops serving
// LL-HLS. `upload` is the escape hatch that depends on no foreign service.
//
// The obvious Russian answer, the free certificates from the Ministry of
// Digital Development, is available through `upload` — but its root is not in
// Apple's or Chrome's trust stores, only in Yandex Browser and after a manual
// install elsewhere. LL-HLS players are overwhelmingly Apple's. A certificate
// the player refuses produces exactly the failure this whole feature is meant
// to avoid: playback that silently is not what it claims to be. The panel says
// so rather than discovering it in a support ticket.
//
// None of that is settled by reading. `tlsProbe.js` already reports
// `certTrusted` from a handshake, and that handshake is what decides whether a
// certificate is usable — this file only catches what can be caught before
// anything is installed.

import { X509Certificate, createPrivateKey } from 'node:crypto';

export const METHODS = {
  'acme-http': {
    id: 'acme-http',
    label: 'Let\'s Encrypt over port 80',
    automaticRenewal: true,
    // Everything here must be true before the plan is worth composing, and
    // each one is a thing the panel can check rather than a thing to hope for.
    requires: ['domain', 'port-80-reachable', 'dns-a-record'],
    wildcard: false,
    cost: 'Port 80 must be reachable from the internet for a few seconds every renewal.',
  },
  'acme-dns': {
    id: 'acme-dns',
    label: 'Let\'s Encrypt over a DNS record',
    automaticRenewal: true,
    requires: ['domain', 'dns-provider', 'dns-api-token'],
    wildcard: true,
    cost: 'An API token for the DNS zone lives on the machine. Scope it to that zone.',
  },
  upload: {
    id: 'upload',
    label: 'A certificate you already have',
    automaticRenewal: false,
    requires: ['domain', 'certificate', 'private-key'],
    wildcard: null,       // whatever was issued
    cost: 'Nothing renews it. The panel counts down and warns; replacing it is yours.',
  },
};

// certbot's DNS plugins, each a package and a flag. Only the ones this project
// has a reason to offer — a list of forty would be a list nobody reads.
export const DNS_PROVIDERS = {
  cloudflare: { package: 'python3-certbot-dns-cloudflare', flag: '--dns-cloudflare',
                credentialsArg: '--dns-cloudflare-credentials',
                credentials: (token) => `dns_cloudflare_api_token = ${token}\n` },
  route53: { package: 'python3-certbot-dns-route53', flag: '--dns-route53',
             credentialsArg: null, credentials: null },
  digitalocean: { package: 'python3-certbot-dns-digitalocean', flag: '--dns-digitalocean',
                  credentialsArg: '--dns-digitalocean-credentials',
                  credentials: (token) => `dns_digitalocean_token = ${token}\n` },
};

// ---------------------------------------------------------------------------
// What a chosen method still needs.
//
// Returned rather than thrown, and each missing thing named separately: an
// operator who has the token but not the domain should be told both, once.
export function missingInputs(method, input = {}) {
  const m = METHODS[method];
  if (!m) return ['unknown-method'];
  const missing = [];
  if (!input.domain) missing.push('domain');

  if (method === 'acme-dns') {
    if (!input.dnsProvider) missing.push('dns-provider');
    else if (!DNS_PROVIDERS[input.dnsProvider]) missing.push('unsupported-dns-provider');
    else if (DNS_PROVIDERS[input.dnsProvider].credentialsArg && !input.dnsToken) missing.push('dns-api-token');
  }
  if (method === 'upload') {
    if (!input.certificatePem) missing.push('certificate');
    if (!input.privateKeyPem) missing.push('private-key');
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Reading an uploaded certificate before it goes anywhere.
//
// Every one of these has been somebody's outage: a key that belongs to a
// different certificate, a certificate for the wrong name, one that expired
// last month, a chain missing its intermediate so half the clients fail and
// half do not.
//
// What this cannot tell you is whether a player will accept it. That is a
// property of the client's trust store, and the only honest test is the
// handshake `tlsProbe.js` makes afterwards.
export function inspectUploaded({ certificatePem, privateKeyPem, domain, now = new Date() }) {
  const problems = [];
  const notes = [];
  let cert = null;

  try {
    cert = new X509Certificate(String(certificatePem || ''));
  } catch (e) {
    return { ok: false, problems: ['certificate-unreadable'], detail: String(e?.message || e), notes };
  }

  // The key must belong to this certificate. `checkPrivateKey` is the check
  // that a matching-looking file passes and a wrong one does not.
  try {
    const key = createPrivateKey(String(privateKeyPem || ''));
    if (!cert.checkPrivateKey(key)) problems.push('key-does-not-match-certificate');
  } catch (e) {
    problems.push('key-unreadable');
  }

  const validFrom = new Date(cert.validFrom);
  const validTo = new Date(cert.validTo);
  if (now > validTo) problems.push('expired');
  else if (now < validFrom) problems.push('not-yet-valid');

  const daysLeft = Math.floor((validTo - now) / 86400000);

  // The name, from the SAN — not the subject CN, which browsers stopped
  // honouring years ago and which is exactly the sort of thing that works in
  // curl and fails in Safari.
  const names = String(cert.subjectAltName || '')
    .split(',').map(s => s.trim())
    .filter(s => s.startsWith('DNS:')).map(s => s.slice(4));
  if (domain && !coversDomain(names, domain)) problems.push('certificate-does-not-cover-domain');

  // Self-issued: subject equals issuer. A self-signed certificate is refused
  // by every player, so it is a problem rather than a note.
  if (cert.subject === cert.issuer) problems.push('self-signed');

  // An end-entity certificate alone, with no intermediate after it, is the
  // failure that reproduces on some clients and not others — which is worse
  // than one that fails everywhere.
  const certCount = (String(certificatePem).match(/-----BEGIN CERTIFICATE-----/g) || []).length;
  if (certCount === 1 && cert.subject !== cert.issuer) {
    notes.push('no-intermediate-bundled');
  }

  if (daysLeft <= 30 && !problems.includes('expired')) notes.push('expires-soon');

  return {
    ok: problems.length === 0,
    problems,
    notes,
    subject: cert.subject,
    issuer: cert.issuer,
    names,
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
    daysLeft,
    // Said plainly, because an offline check that passes is easy to read as
    // approval: nothing here proves a player will accept this.
    trustUnknown: true,
  };
}

export function coversDomain(names, domain) {
  const d = String(domain).toLowerCase();
  return names.some(n => {
    const name = String(n).toLowerCase();
    if (name === d) return true;
    if (!name.startsWith('*.')) return false;
    // A wildcard covers one label and only one: `*.example.com` matches
    // `a.example.com` and not `a.b.example.com`, and not `example.com`.
    const suffix = name.slice(1);
    if (!d.endsWith(suffix)) return false;
    return !d.slice(0, d.length - suffix.length).includes('.');
  });
}

// ---------------------------------------------------------------------------
// The steps, in the same shapes the agent already executes: package, file,
// command. Nothing new for it to understand.
//
// Paths follow certbot's own layout so that a certificate obtained by one
// method and one obtained by another end up in the same place — the Nimble
// configuration that points at them should not care which was used.
export const certDir = (domain) => `/etc/letsencrypt/live/${domain}`;
export const certPath = (domain) => `${certDir(domain)}/fullchain.pem`;
export const keyPath = (domain) => `${certDir(domain)}/privkey.pem`;

// `role` decides how the HTTP challenge is answered, and getting it wrong is
// silent: `--webroot -w /var/www/html` needs something serving that directory
// on port 80. On a gateway that is nginx, which the gateway plan installed. On
// an edge there is no web server at all — Nimble serves playlists on 8081 and
// nothing answers 80 — so certbot has to bind the port itself.
//
// Ports 80 and 443 are free on these edges. That was checked rather than
// assumed: Nimble listens on 8081, 1935 and 8082, and the note claiming
// otherwise is corrected in docs/STATE.md.
export function buildSteps({ method, domain, email, dnsProvider, dnsToken,
                             certificatePem, privateKeyPem, role = 'edge' }) {
  const missing = missingInputs(method, { domain, dnsProvider, dnsToken, certificatePem, privateKeyPem });
  if (missing.length) return { ok: false, missing, steps: [] };

  const steps = [];
  const acmeAccount = email ? ['--email', email] : ['--register-unsafely-without-email'];

  if (method === 'acme-http') {
    steps.push(
      { id: 'install-certbot', kind: 'package', why: 'the certificate is issued and renewed automatically',
        command: ['apt-get', 'install', '-y', 'certbot'],
        undo: null, skipIf: 'certbot-installed' },
      { id: 'issue-certificate', kind: 'command',
        why: role === 'gateway'
          ? 'certbot proves the domain through the web server already running here'
          : 'certbot binds port 80 itself, because nothing else on this machine serves it',
        command: ['certbot', 'certonly',
                  ...(role === 'gateway' ? ['--webroot', '-w', '/var/www/html'] : ['--standalone']),
                  '--non-interactive', '--agree-tos', ...acmeAccount, '-d', String(domain)],
        // Nothing to undo: a certificate that exists harms nothing, and
        // deleting it throws away something rate-limited and slow to replace.
        undo: null, needsPort: 80, skipIf: 'cert-present' },
    );
  }

  if (method === 'acme-dns') {
    const p = DNS_PROVIDERS[dnsProvider];
    steps.push(
      { id: 'install-certbot', kind: 'package', why: 'the ACME client itself',
        command: ['apt-get', 'install', '-y', 'certbot'], undo: null, skipIf: 'certbot-installed' },
      { id: 'install-dns-plugin', kind: 'package',
        why: `certbot cannot write a ${dnsProvider} record without its plugin`,
        command: ['apt-get', 'install', '-y', p.package],
        undo: ['apt-get', 'remove', '-y', p.package], skipIf: null },
    );
    if (p.credentialsArg) {
      steps.push({
        id: 'write-dns-credentials', kind: 'file',
        why: 'certbot reads the token from a file, not from the command line',
        path: `/etc/letsencrypt/${dnsProvider}.ini`,
        content: p.credentials(dnsToken),
        // 0600 and never echoed. A token on the command line lands in the
        // audit record, in the process list and in anybody's shell history.
        mode: '0600',
        secret: true,
        backup: true, undo: 'restore',
      });
    }
    steps.push({
      id: 'issue-certificate', kind: 'command',
      why: 'certbot proves the domain by DNS, so nothing inbound is needed',
      command: ['certbot', 'certonly', p.flag,
                ...(p.credentialsArg ? [p.credentialsArg, `/etc/letsencrypt/${dnsProvider}.ini`] : []),
                '--non-interactive', '--agree-tos', ...acmeAccount, '-d', String(domain)],
      undo: null, needsPort: null, skipIf: 'cert-present',
    });
  }

  if (method === 'upload') {
    steps.push(
      { id: 'write-certificate', kind: 'file',
        why: 'the certificate you supplied, where Nimble will look for it',
        path: certPath(domain), content: String(certificatePem),
        mode: '0644', backup: true, undo: 'restore' },
      { id: 'write-key', kind: 'file',
        why: 'the private key for it',
        path: keyPath(domain), content: String(privateKeyPem),
        mode: '0600', secret: true, backup: true, undo: 'restore' },
    );
  }

  return {
    ok: true,
    missing: [],
    steps,
    certPath: certPath(domain),
    keyPath: keyPath(domain),
    automaticRenewal: METHODS[method].automaticRenewal,
    // Stated with the plan rather than discovered at expiry. An upload with
    // nobody watching the clock is a scheduled outage.
    renewalNote: METHODS[method].automaticRenewal
      ? 'certbot renews this on its own timer; the panel checks the expiry anyway.'
      : 'Nothing renews this. The panel warns as the expiry approaches; replacing it is a manual step.',
  };
}

// Every path and binary these plans touch, so the privileged helper's
// allow-lists can be checked against them rather than kept in step by hand.
// Per role, because the edge profile has no webroot and a path listed for it
// that the helper refuses would be a step that fails at apply.
export const PATHS_TOUCHED = {
  gateway: ['/etc/letsencrypt', '/var/www/html', '/var/log/letsencrypt', '/var/lib/letsencrypt'],
  edge: ['/etc/letsencrypt', '/var/log/letsencrypt', '/var/lib/letsencrypt'],
};
export const BINARIES_USED = ['apt-get', 'certbot'];
