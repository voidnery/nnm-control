// Exactly what will be run, and exactly what will be written.
//
// This is the half that must be right before anything is applied, and it has
// one rule above all others: **the plan shown is the plan applied**. Not a
// summary of it, not an approximation — the same objects, produced by this
// function, are what the apply path executes. A preview computed separately
// from the work is a preview that drifts, and the drift is invisible until the
// day it matters.
//
// The panel is about to change a system. Everything it has written until now
// went into somebody else's API, where a wrong call is refused; `apt-get` is
// not refused. So every step here declares what it touches, what it will look
// like afterwards, and how to put it back.

import { buildSteps as certSteps, METHODS, missingInputs } from './certPlan.js';

const isDomain = (d) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(String(d || ''));

// A gateway's nginx: TLS in front, and a resolver so edge names are looked up
// per request rather than once at start-up.
//
// The resolver line is not decoration. Without it nginx resolves an upstream
// name when it loads its configuration and keeps that address until somebody
// restarts it — so an edge that changes address, or is replaced, keeps
// receiving nothing until a human notices. That is the failure which makes a
// balancer worse than no balancer, and it is one line.
// A server block that exists only to answer the ACME challenge.
//
// certbot needs something serving the domain on port 80 while it proves
// ownership. `--standalone` binds 80 itself, which fails once nginx is there —
// and nginx is there, because this plan just installed it. Stopping nginx to
// issue and starting it again would take the machine down twice per renewal.
//
// So: a config that serves the challenge and nothing else, written before the
// certificate exists — because the real config references a certificate file
// and nginx will not load a config pointing at a file that is not there.
export function acmeConf({ domain }) {
  return `# Written by NNM Control, to answer the ACME challenge only.
# Replaced by the real configuration once the certificate exists.
server {
    listen 80;
    server_name ${domain};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
`;
}

export function nginxConf({ domain, mode = 'redirect', resolvers = '127.0.0.53 1.1.1.1', edges = [] }) {
  const upstreamBlock = mode === 'proxy'
    ? `
    # Proxy mode: the viewer never learns an edge address, and every byte
    # passes through this machine — which is the cost, stated where it is paid.
    location / {
        # Resolved per request, deliberately: see the resolver note above.
        # Filled in when this machine joins a network. The placeholder is a
        # reserved TLD and can never resolve, so it fails loudly
        # rather than quietly pointing somewhere real.
        set $edge "${edges[0]?.host || 'edge.invalid'}:${edges[0]?.httpPort || 8081}";
        proxy_pass http://$edge;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        # Playlists change every segment; segments never change. Letting nginx
        # cache the playlist would serve a stale one to everybody.
        proxy_buffering off;
    }`
    : `
    # Redirect mode: this machine decides which edge and says so with a 302.
    # The viewer then talks to the edge directly, so this box carries decisions
    # and not video — and the edge address ends up in the viewer's hands.
    location / {
        # The edge, written in.
        #
        # This named a variable nothing ever defined — and nginx
        # refuses a configuration that reads one, so this config was never
        # valid. It went unnoticed because nothing applied it until the resync
        # learned to write redirect mode, and then nginx -t caught it one
        # step before the reload.
        #
        # Substituted rather than resolved at request time, exactly as proxy
        # mode does: the panel rewrites this file whenever the network changes,
        # so the address here is as current as the edge list itself.
        # The scheme is the edge's, not the viewer's.
        #
        # The scheme variable inherits how the viewer arrived, so a viewer
        # on https was sent to https://<edge>:8081 — plain HTTP behind a TLS
        # scheme. The connection failed at the handshake and the player
        # reported only that it could not open the source.
        #
        # A redirect is an address somebody else will dial, so every part of it
        # has to be true of the machine at the other end. TLS here comes from
        # the panel's own handshake with that edge, not from an assumption.
        return 302 ${edges[0]
          ? (edges[0].httpsPort
              ? `https://${edges[0].host}${edges[0].httpsPort === 443 ? '' : `:${edges[0].httpsPort}`}`
              : `http://${edges[0].host}:${edges[0].httpPort || 8081}`)
          : 'https://edge.invalid'}$request_uri;
    }`;

  return `# Written by NNM Control. Edited by hand? The panel will show a diff
# rather than overwrite silently.
#
# Reload with: nginx -t && systemctl reload nginx

# Names are resolved per request rather than once at start-up. Without this
# nginx keeps the address it saw when it loaded, and an edge that moves keeps
# receiving nothing until somebody restarts it.
resolver ${resolvers} valid=30s ipv6=off;
resolver_timeout 5s;

server {
    listen 80;
    server_name ${domain};

    # ACME first, so renewal keeps working, and only then the redirect. The
    # other order breaks renewal the moment TLS is on.
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    # HTTP/2 on the listen line, not as its own directive.
    #
    # The http2 directive on its own line is nginx 1.25.1 and later. Ubuntu
    # 24.04 ships 1.24, where it is unknown and the whole configuration fails
    # to load — which nginx -t caught, one step before a reload would have
    # taken the machine off the air.
    #
    # This form works on both. Newer nginx warns that it is deprecated and
    # accepts it; a warning on a working server beats an error on half the
    # ones this will run on. The plan cannot read the version before nginx is
    # installed, so the compatible spelling is the only one that is right
    # everywhere.
    #
    # It is not optional either way: LL-HLS requires HTTP/2, and a player
    # without it falls back to ordinary HLS in silence.
    listen 443 ssl http2;
    server_name ${domain};

    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
${upstreamBlock}
}
`;
}

// The steps, in the order they must happen, each saying what it touches.
//
// Ordered so that nothing irreversible happens before the things that can
// fail: ports are checked, then packages, then a certificate, and only then is
// a configuration written and a service reloaded.
export function gatewayPlan({
  server, domain, mode = 'redirect', edges = [], ports = null, email = '',
  // How the certificate arrives. This plan used to know exactly one answer —
  // Let's Encrypt through the nginx it had just started — while the LL-HLS
  // screen offered three. The same question with two different sets of answers
  // depending on which page you opened it from.
  //
  // The three now live in certPlan.js and both callers use them. What differs
  // between a gateway and an edge is not the question but where the result
  // goes, and that follows from the machine rather than from the operator.
  certMethod = 'acme-http', dnsProvider = '', dnsToken = '',
  certificatePem = '', privateKeyPem = '',
}) {
  const problems = [];
  if (!isDomain(domain)) problems.push({ code: 'bad-domain', severity: 'block' });
  if (!['redirect', 'proxy'].includes(mode)) problems.push({ code: 'bad-mode', severity: 'block' });
  if (!METHODS[certMethod]) problems.push({ code: 'bad-cert-method', severity: 'block' });
  for (const m of missingInputs(certMethod, { domain, dnsProvider, dnsToken, certificatePem, privateKeyPem })) {
    // `domain` already has its own blocker above, and reporting it twice under
    // two names sends an operator looking for a second problem.
    if (m !== 'domain') problems.push({ code: `cert-${m}`, severity: 'block' });
  }
  // Proxy mode with no edges yet is the normal order of work, not a fault: a
  // machine is prepared and *then* joined to a network. Refusing it here told
  // an operator preparing a fresh VM that their brand-new machine was
  // misconfigured for not already being in a topology it cannot be in.
  //
  // It is still worth saying, because a proxy gateway with nowhere to forward
  // to answers nothing — so it is a note, and the nginx it writes points at a
  // placeholder that is obviously a placeholder rather than at a guess.
  if (mode === 'proxy' && !edges.length) problems.push({ code: 'proxy-has-no-edge-yet', severity: 'note' });

  // Ports first, and blocking. Installing nginx where something already holds
  // 80 produces a broken service rather than an error, and the operator finds
  // out by way of an outage somebody else is having.
  // nginx on 80 and 443 is not a conflict on a machine being prepared for
  // nginx. It is what a second run looks like: the first one installed it, and
  // blocking on our own successful work is absurd.
  //
  // Named by unit and process rather than assumed: something else called nginx
  // and started by hand is a different situation from the unit this plan
  // manages, and only the unit gets the exemption.
  const isOurs = (h) => h.unit === 'nginx.service' || (h.process === 'nginx' && !h.unit);

  const held = [];
  if (ports) {
    for (const p of [80, 443]) {
      const st = ports[p] || ports[String(p)];
      const holders = (st?.holders || []).filter(h => !isOurs(h));
      if (st?.taken && holders.length) held.push({ port: p, holders });
      // Unknown is not free. `ss` missing means the panel could not look, and
      // proceeding on that is exactly the assumption this project keeps
      // refusing to make.
      if (st?.taken === null) problems.push({ code: 'ports-unknown', severity: 'block', port: p });
    }
    if (held.length) problems.push({ code: 'ports-held', severity: 'block', held });
    // Ours, and only ours: worth saying, because a reload is not an install
    // and the operator should know which of the two is about to happen.
    const ours = [80, 443]
      .map(p => ({ port: p, holders: ((ports[p] || ports[String(p)])?.holders || []).filter(isOurs) }))
      .filter(x => x.holders.length);
    if (ours.length) problems.push({ code: 'nginx-already-here', severity: 'note', ours });
  } else {
    problems.push({ code: 'ports-not-checked', severity: 'block' });
  }

  const conf = nginxConf({ domain, mode, edges });
  const steps = [
    {
      id: 'install-nginx',
      kind: 'package',
      why: 'the gateway terminates TLS and forwards',
      command: ['apt-get', 'install', '-y', 'nginx'],
      // Named so the rollback is not a guess. A step that cannot say how to
      // undo itself does not belong in a plan the panel presents as safe.
      undo: ['apt-get', 'remove', '-y', 'nginx'],
      skipIf: 'nginx-installed',
    },
    // Not for an uploaded certificate: nothing about placing a file the
    // operator already has needs an ACME client, and installing one would be
    // a package added to a machine to do nothing.
    ...(certMethod === 'upload' ? [] : [
    {
      id: 'install-certbot',
      kind: 'package',
      why: 'the certificate is issued and renewed automatically',
      command: ['apt-get', 'install', '-y', 'certbot'],
      undo: ['apt-get', 'remove', '-y', 'certbot'],
      skipIf: 'certbot-installed',
    },
    ]),
    {
      id: 'drop-stale-site',
      kind: 'command',
      why: 'a previous run may have left a configuration nginx now refuses',
      // A halted plan leaves the production config written and enabled: the
      // halt happens at `nginx -t`, which is after `enable-site`. The next run
      // then reloads nginx for the ACME phase and trips over that file — a
      // failure with nothing to do with the run causing it, and the message
      // points at a config this run has not written yet.
      //
      // Unlinked, not deleted: the file stays in sites-available, and the undo
      // puts the link back for anyone who wants to look at what failed.
      command: ['rm', '-f', `/etc/nginx/sites-enabled/nnm-${domain}.conf`],
      undo: ['ln', '-sf', `/etc/nginx/sites-available/nnm-${domain}.conf`,
             `/etc/nginx/sites-enabled/nnm-${domain}.conf`],
    },
    // Only Let's Encrypt over port 80 needs nginx to answer a challenge. A DNS
    // challenge proves the domain elsewhere, and an uploaded certificate
    // proves nothing at all — for either, these three steps would start a
    // temporary site, reload nginx and take it down again to accomplish
    // nothing.
    ...(certMethod === 'acme-http' ? [
    {
      id: 'write-acme-conf',
      kind: 'file',
      why: 'somewhere for certbot to prove the domain',
      path: `/etc/nginx/sites-available/nnm-acme-${domain}.conf`,
      content: acmeConf({ domain }),
      backup: true,
      undo: 'restore',
    },
    {
      id: 'enable-acme',
      kind: 'command',
      why: 'nginx only reads what is linked',
      command: ['ln', '-sf', `/etc/nginx/sites-available/nnm-acme-${domain}.conf`,
                `/etc/nginx/sites-enabled/nnm-acme-${domain}.conf`],
      undo: ['rm', '-f', `/etc/nginx/sites-enabled/nnm-acme-${domain}.conf`],
    },
    {
      id: 'test-acme-conf',
      kind: 'command',
      why: 'a broken file must not reach a reload',
      command: ['nginx', '-t'],
      undo: null,
      halting: true,
    },
    {
      id: 'reload-for-acme',
      kind: 'command',
      why: 'so the challenge is answerable before it is asked for',
      command: ['systemctl', 'reload-or-restart', 'nginx'],
      // Reloading again is the undo: by then the temporary block has been
      // unlinked by its own step's undo, so nginx comes back without it. A
      // step that changes a running service and claims nothing to reverse is
      // the shape the gate was written to catch, and it caught this.
      undo: ['systemctl', 'reload-or-restart', 'nginx'],
    },
    ] : []),

    // Obtaining it, whichever way was chosen. `install-certbot` above already
    // covers the client itself; a DNS method adds its plugin, and an upload
    // adds nothing and contacts nobody.
    ...certSteps({
      method: certMethod, domain, email, dnsProvider, dnsToken,
      certificatePem, privateKeyPem, role: 'gateway',
    }).steps.filter(st => st.id !== 'install-certbot'),

    {
      id: 'write-conf',
      kind: 'file',
      why: 'the gateway configuration itself',
      path: `/etc/nginx/sites-available/nnm-${domain}.conf`,
      content: conf,
      // Backed up before writing, and the backup is what the undo restores.
      backup: true,
      undo: 'restore',
    },
    ...(certMethod === 'acme-http' ? [{
      id: 'drop-acme-conf',
      kind: 'command',
      why: 'the real configuration answers the challenge too',
      command: ['rm', '-f', `/etc/nginx/sites-enabled/nnm-acme-${domain}.conf`],
      undo: ['ln', '-sf', `/etc/nginx/sites-available/nnm-acme-${domain}.conf`,
             `/etc/nginx/sites-enabled/nnm-acme-${domain}.conf`],
    }] : []),
    {
      id: 'enable-site',
      kind: 'command',
      why: 'nginx only reads what is linked',
      command: ['ln', '-sf', `/etc/nginx/sites-available/nnm-${domain}.conf`,
                `/etc/nginx/sites-enabled/nnm-${domain}.conf`],
      undo: ['rm', '-f', `/etc/nginx/sites-enabled/nnm-${domain}.conf`],
    },
    // No step removes the distribution's default site.
    //
    // It was a candidate for the 403 on the ACME challenge and it was not the
    // cause: `nginx -T` showed our block loaded and matching, and the fault
    // was 0700 on /var/www/html. Our server_name is exact, so it wins over
    // default_server for this host regardless.
    //
    // Removing it anyway would be a change to somebody's machine that nothing
    // asked for, on a hypothesis already ruled out — and that is the shape of
    // change this whole plan exists to avoid making.
    {
      id: 'test-conf',
      kind: 'command',
      why: 'a bad configuration must not reach a reload',
      command: ['nginx', '-t'],
      undo: null,
      // A failure here stops everything after it: reloading nginx onto a
      // configuration it has just rejected is how a working machine stops
      // working.
      halting: true,
    },
    {
      id: 'reload',
      kind: 'command',
      why: 'apply it',
      command: ['systemctl', 'reload-or-restart', 'nginx'],
      undo: ['systemctl', 'reload-or-restart', 'nginx'],
    },
  ];

  return {
    domain, mode,
    steps,
    problems,
    blocking: problems.filter(p => p.severity === 'block'),
    // What the operator is agreeing to, counted rather than described: three
    // packages and two files reads differently from "prepare the machine".
    summary: {
      packages: steps.filter(s => s.kind === 'package').length,
      files: steps.filter(s => s.kind === 'file').length,
      commands: steps.filter(s => s.kind === 'command').length,
    },
  };
}

// Stopping what holds a port. Separate from the plan on purpose: this is the
// one destructive thing here, and it is somebody else's service.
export function replacePlan(held) {
  return held.flatMap(({ port, holders }) => holders.map(h => ({
    id: `stop-${h.pid}`,
    kind: 'command',
    why: `${h.process} is holding ${port}`,
    // A unit is stopped by name; a bare process has to be killed, and the two
    // are not interchangeable — stopping a unit that will be restarted by
    // systemd looks like it worked and is not.
    command: h.unit ? ['systemctl', 'stop', h.unit] : ['kill', String(h.pid)],
    undo: h.unit ? ['systemctl', 'start', h.unit] : null,
    // Said plainly: a process without a unit cannot be started again by the
    // panel, and the operator is agreeing to that.
    reversible: Boolean(h.unit),
  })));
}
